import { extractText, getDocumentProxy } from "unpdf";
import { AppError, errorMessage } from "../shared/errors";
import { fetchWithTimeout } from "../shared/http";

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 60_000;

export interface ResumeTextResult {
  text: string;
  sourceLabel: string;
  contentType: string;
  bytes: Uint8Array;
}

function truncateText(text: string): string {
  // Strip NUL bytes that sometimes appear in extracted PDF text.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional NUL strip
  const cleaned = text.replace(/\u0000/g, "").trim();
  if (cleaned.length <= MAX_TEXT_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_TEXT_CHARS)}\n\n[truncated]`;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

async function pdfToText(bytes: Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(bytes);
  const result = await extractText(pdf, { mergePages: true });
  const text = result.text as string | string[];
  return Array.isArray(text) ? text.join("\n") : text;
}

function isPrivateOrLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return true;
  }

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const parts = ipv4.slice(1).map(Number);
    const [a, b] = parts;
    if (a === undefined || b === undefined) return true;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }

  // IPv6 unique-local / link-local prefixes
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) return true;
  return false;
}

export function assertSafeResumeUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AppError("resume_invalid_url", "Resume URL must be http(s)");
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new AppError("resume_blocked_host", "That host is not allowed for resume downloads");
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new AppError("resume_too_large", `Resume exceeds ${maxBytes} bytes`);
  }

  if (!response.body) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new AppError("resume_too_large", `Resume exceeds ${maxBytes} bytes`);
    }
    return new Uint8Array(buffer);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("resume_too_large", `Resume exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export async function resumeBytesToText(
  bytes: Uint8Array,
  contentType: string,
  sourceLabel: string,
): Promise<ResumeTextResult> {
  if (bytes.byteLength === 0) {
    throw new AppError("resume_empty", "Resume file was empty");
  }
  if (bytes.byteLength > MAX_BYTES) {
    throw new AppError("resume_too_large", `Resume exceeds ${MAX_BYTES} bytes`);
  }

  const lower = contentType.toLowerCase();
  const looksPdf =
    lower.includes("pdf") ||
    sourceLabel.toLowerCase().endsWith(".pdf") ||
    (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46);

  if (looksPdf) {
    try {
      const text = truncateText(await pdfToText(bytes));
      if (text.length < 40) {
        throw new AppError("resume_unreadable", "Could not extract enough text from PDF");
      }
      return { text, sourceLabel, contentType: "application/pdf", bytes };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("resume_pdf_parse_failed", `PDF parse failed: ${errorMessage(error)}`);
    }
  }

  const decoder = new TextDecoder("utf-8");
  const raw = decoder.decode(bytes);
  const text = truncateText(
    lower.includes("html") || /<html[\s>]/i.test(raw) ? stripHtml(raw) : raw,
  );
  if (text.length < 40) {
    throw new AppError("resume_unreadable", "Could not extract enough text from resume");
  }
  return { text, sourceLabel, contentType: contentType || "text/plain", bytes };
}

export interface ResumeBytesResult {
  bytes: Uint8Array;
  sourceLabel: string;
  contentType: string;
}

export async function fetchResumeBytesFromUrl(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ResumeBytesResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError("resume_invalid_url", "That does not look like a valid URL");
  }
  assertSafeResumeUrl(parsed);

  const response = await fetchWithTimeout(
    fetchImpl,
    parsed.toString(),
    {
      method: "GET",
      headers: { Accept: "application/pdf,text/plain,text/html,*/*" },
      // Manual redirects so each hop can be host-checked.
      redirect: "manual",
    },
    20_000,
  );

  let current = response;
  let finalUrl = parsed;
  for (let hop = 0; hop < 5 && [301, 302, 303, 307, 308].includes(current.status); hop++) {
    const location = current.headers.get("location");
    if (!location) {
      throw new AppError("resume_fetch_failed", "Resume URL redirected without Location");
    }
    finalUrl = new URL(location, finalUrl);
    assertSafeResumeUrl(finalUrl);
    current = await fetchWithTimeout(
      fetchImpl,
      finalUrl.toString(),
      {
        method: "GET",
        headers: { Accept: "application/pdf,text/plain,text/html,*/*" },
        redirect: "manual",
      },
      20_000,
    );
  }

  if (!current.ok) {
    throw new AppError("resume_fetch_failed", `Could not download resume (HTTP ${current.status})`);
  }

  const bytes = await readBodyCapped(current, MAX_BYTES);
  if (bytes.byteLength === 0) {
    throw new AppError("resume_empty", "Resume file was empty");
  }
  const contentType = current.headers.get("content-type") ?? "";
  return { bytes, sourceLabel: finalUrl.toString(), contentType };
}

export async function fetchResumeFromUrl(
  url: string,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ResumeTextResult> {
  const raw = await fetchResumeBytesFromUrl(url, fetchImpl);
  return resumeBytesToText(raw.bytes, raw.contentType, raw.sourceLabel);
}

export async function downloadTelegramFileBytes(options: {
  token: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResumeBytesResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const metaResponse = await fetchWithTimeout(
    fetchImpl,
    `https://api.telegram.org/bot${options.token}/getFile`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: options.fileId }),
    },
    15_000,
  );
  if (!metaResponse.ok) {
    throw new AppError("telegram_getfile_failed", `getFile HTTP ${metaResponse.status}`);
  }
  const meta = (await metaResponse.json()) as {
    ok: boolean;
    result?: { file_path?: string; file_size?: number };
    description?: string;
  };
  if (!meta.ok || !meta.result?.file_path) {
    throw new AppError("telegram_getfile_failed", meta.description ?? "Telegram getFile failed");
  }
  if ((meta.result.file_size ?? 0) > MAX_BYTES) {
    throw new AppError("resume_too_large", `Resume exceeds ${MAX_BYTES} bytes`);
  }

  const fileUrl = `https://api.telegram.org/file/bot${options.token}/${meta.result.file_path}`;
  const fileResponse = await fetchWithTimeout(fetchImpl, fileUrl, { method: "GET" }, 20_000);
  if (!fileResponse.ok) {
    throw new AppError(
      "telegram_download_failed",
      `Telegram file download HTTP ${fileResponse.status}`,
    );
  }
  const bytes = await readBodyCapped(fileResponse, MAX_BYTES);
  if (bytes.byteLength === 0) {
    throw new AppError("resume_empty", "Resume file was empty");
  }
  const label = options.fileName ?? meta.result.file_path;
  const contentType =
    options.mimeType ??
    (label.toLowerCase().endsWith(".pdf") ? "application/pdf" : "application/octet-stream");
  return { bytes, sourceLabel: label, contentType };
}

export async function downloadTelegramFile(options: {
  token: string;
  fileId: string;
  fileName?: string;
  mimeType?: string;
  fetchImpl?: typeof fetch;
}): Promise<ResumeTextResult> {
  const raw = await downloadTelegramFileBytes(options);
  return resumeBytesToText(raw.bytes, raw.contentType, raw.sourceLabel);
}

export function extractFirstUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  return match[0].replace(/[),.;]+$/g, "");
}
