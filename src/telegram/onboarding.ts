import {
  buildCandidateProfileFromDraft,
  type OnboardingDraft,
  parseExtractedResume,
  renderDraftSummary,
} from "../candidate/extract-profile";
import type { SearchPreferences } from "../candidate/preferences";
import { getUserResume } from "../db/repositories/user-resumes";
import {
  clearUserSession,
  getUserSession,
  upsertUserSession,
} from "../db/repositories/user-sessions";
import { getUserProfile, setUserActive, upsertUserProfile } from "../db/repositories/users";
import type { UserRow, UserSessionRow, UserSessionState } from "../db/schema";
import type { LlmClient } from "../llm/client";
import {
  downloadTelegramFile,
  extractFirstUrl,
  fetchResumeFromUrl,
  type ResumeTextResult,
} from "../resume/fetch";
import { persistResumeFile } from "../resume/store";
import { errorMessage } from "../shared/errors";
import type { TelegramClient } from "./client";

const WELCOME = [
  "<b>Welcome to job-maxxing</b>",
  "",
  "To get started, send your resume now:",
  "• Upload a <b>PDF</b> in this chat, or",
  "• Paste a <b>public resume link</b> (PDF, text, or HTML)",
  "",
  "I’ll extract your profile, ask a few search preferences, then send matching jobs here (about every 3 hours).",
  "Nothing is submitted until you tap Confirm apply.",
].join("\n");

export function isOnboardingInProgress(session: UserSessionRow | null): boolean {
  if (!session || session.state === "ready") return false;
  if (session.state.startsWith("applying_")) return false;
  return true;
}

function parseDraft(raw: string | null): OnboardingDraft | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as OnboardingDraft;
    parsed.extracted = parseExtractedResume(parsed.extracted);
    return parsed;
  } catch {
    return null;
  }
}

async function saveSession(
  db: D1Database,
  userId: string,
  state: UserSessionState,
  draft: OnboardingDraft | null,
): Promise<void> {
  await upsertUserSession(db, {
    userId,
    state,
    draftJson: draft ? JSON.stringify(draft) : null,
  });
}

function parseCommaList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseWorkplace(text: string): Pick<SearchPreferences, "remote" | "hybrid" | "onsite"> {
  const lower = text.toLowerCase();
  if (lower.includes("any") || lower.includes("all")) {
    return { remote: true, hybrid: true, onsite: true };
  }
  const remote = /\bremote\b/.test(lower);
  const hybrid = /\bhybrid\b/.test(lower);
  const onsite = /\b(onsite|on-site|office)\b/.test(lower);
  if (!remote && !hybrid && !onsite) {
    return { remote: true, hybrid: true, onsite: false };
  }
  return { remote, hybrid, onsite };
}

function parseSalary(text: string): number | undefined {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed || trimmed === "skip" || trimmed === "-" || trimmed === "none") return undefined;
  const digits = trimmed.replace(/[$,_\s]/g, "");
  const n = Number(digits);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

/** Parse "US yes no no" or "yes / no / no" style auth answers. */
function parseAuthorization(text: string): OnboardingDraft["authorization"] | null {
  const parts = text
    .split(/[,/|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 3) return null;

  let country = "United States";
  let rest = parts;
  const firstLower = parts[0]?.toLowerCase() ?? "";
  if (!["yes", "y", "no", "n", "true", "false"].includes(firstLower)) {
    country = parts[0] ?? country;
    rest = parts.slice(1);
  }
  if (rest.length < 3) return null;

  const toBool = (v: string): boolean | null => {
    const l = v.toLowerCase();
    if (["yes", "y", "true", "1"].includes(l)) return true;
    if (["no", "n", "false", "0"].includes(l)) return false;
    return null;
  };
  const authorized = toBool(rest[0] ?? "");
  const sponsorNow = toBool(rest[1] ?? "");
  const sponsorFuture = toBool(rest[2] ?? "");
  if (authorized === null || sponsorNow === null || sponsorFuture === null) return null;
  return {
    country,
    authorizedToWork: authorized,
    requiresSponsorshipNow: sponsorNow,
    requiresSponsorshipFuture: sponsorFuture,
  };
}

async function extractAndStartPrefs(
  db: D1Database,
  client: TelegramClient,
  user: UserRow,
  llm: LlmClient,
  resume: ResumeTextResult,
  chatId: string,
): Promise<void> {
  if (!llm.extractProfile) {
    await client.sendMessage({
      chatId,
      text: "Profile extraction is not available right now. Try again later.",
    });
    return;
  }

  await client.sendMessage({
    chatId,
    text: "Got it — extracting your profile…",
  });

  const raw = await llm.extractProfile({ resumeText: resume.text });
  const extracted = parseExtractedResume(raw);
  const draft: OnboardingDraft = {
    extracted,
    resumeSource: resume.sourceLabel,
  };
  await saveSession(db, user.id, "ask_titles", draft);

  await client.sendMessage({
    chatId,
    text: [
      "Here’s what I pulled:",
      "",
      renderDraftSummary(draft),
      "",
      "<b>Step 1/5 — Target titles</b>",
      "Send comma-separated titles (e.g. Software Engineer, Backend Engineer).",
    ].join("\n"),
  });
}

export async function startOnboarding(
  db: D1Database,
  client: TelegramClient,
  user: UserRow,
  chatId: string,
): Promise<void> {
  await saveSession(db, user.id, "awaiting_resume", null);
  await setUserActive(db, user.id, false);
  await client.sendMessage({ chatId, text: WELCOME });
}

export async function handleOnboardingMessage(options: {
  db: D1Database;
  client: TelegramClient;
  user: UserRow;
  chatId: string;
  text?: string;
  document?: {
    fileId: string;
    fileName?: string;
    mimeType?: string;
  };
  botToken: string;
  llm: LlmClient;
  resumes?: R2Bucket;
}): Promise<{ handled: boolean }> {
  const { db, client, user, chatId, llm } = options;
  const session = await getUserSession(db, user.id);
  const text = options.text?.trim() ?? "";

  if (text.toLowerCase() === "/restart" || text.toLowerCase().startsWith("/restart@")) {
    await startOnboarding(db, client, user, chatId);
    return { handled: true };
  }

  if (text.toLowerCase() === "/status" || text.toLowerCase().startsWith("/status@")) {
    const profile = await getUserProfile(db, user.id);
    const midOnboarding = isOnboardingInProgress(session);
    let statusText: string;
    if (user.active === 1) {
      const resume = await getUserResume(db, user.id);
      statusText = resume
        ? "You’re active. Digests will use your saved profile.\n/pause to halt digests.\n/restart to re-onboard."
        : "You’re active, but we don’t have a resume file to attach on Apply.\nUpload a <b>PDF</b> here, or tap Apply and paste a public resume URL.\nYour profile stays as-is.";
    } else if (profile && !midOnboarding) {
      statusText =
        "Paused. No digests until /resume.\nProfile and saved jobs are kept.\n/restart to rebuild your profile.";
    } else {
      const state = session?.state ?? "not_started";
      statusText = `Onboarding in progress: <b>${state}</b>\nSend /start if you need the welcome again.`;
    }
    await client.sendMessage({
      chatId,
      text: statusText,
    });
    return { handled: true };
  }

  // Apply Q&A is handled separately.
  if (session?.state.startsWith("applying_")) {
    return { handled: false };
  }

  // Already onboarded and not mid-wizard → let commands handle /help etc.
  if (user.active === 1 && (!session || session.state === "ready")) {
    return { handled: false };
  }

  const state: UserSessionState =
    (session?.state as UserSessionState | undefined) ?? "awaiting_resume";
  let draft = parseDraft(session?.draft_json ?? null);

  if (!session || state === "awaiting_resume") {
    if (!session) {
      await saveSession(db, user.id, "awaiting_resume", null);
    }

    try {
      let resume: ResumeTextResult | null = null;
      if (options.document) {
        const mime = options.document.mimeType?.toLowerCase() ?? "";
        const name = options.document.fileName?.toLowerCase() ?? "";
        if (!mime.includes("pdf") && !name.endsWith(".pdf")) {
          await client.sendMessage({
            chatId,
            text: "Please upload a PDF in this chat, or paste a public resume URL.",
          });
          return { handled: true };
        }
        resume = await downloadTelegramFile({
          token: options.botToken,
          fileId: options.document.fileId,
          ...(options.document.fileName ? { fileName: options.document.fileName } : {}),
          ...(options.document.mimeType ? { mimeType: options.document.mimeType } : {}),
        });
      } else if (text) {
        const url = extractFirstUrl(text);
        if (!url) {
          await client.sendMessage({
            chatId,
            text: "To continue, upload a PDF in this chat, or paste a public resume URL.",
          });
          return { handled: true };
        }
        resume = await fetchResumeFromUrl(url);
      } else {
        await client.sendMessage({ chatId, text: WELCOME });
        return { handled: true };
      }

      if (options.resumes) {
        await persistResumeFile(db, options.resumes, user.id, {
          bytes: resume.bytes,
          contentType: resume.contentType,
          sourceLabel: resume.sourceLabel,
        });
      }

      await extractAndStartPrefs(db, client, user, llm, resume, chatId);
    } catch (error) {
      await client.sendMessage({
        chatId,
        text: `Couldn’t read that resume: ${errorMessage(error)}\nTry another public URL or PDF.`,
      });
    }
    return { handled: true };
  }

  if (!draft) {
    await startOnboarding(db, client, user, chatId);
    return { handled: true };
  }

  if (!text) {
    await client.sendMessage({
      chatId,
      text: "Please reply with text for this step (or /restart).",
    });
    return { handled: true };
  }

  switch (state) {
    case "ask_titles": {
      const titles = parseCommaList(text);
      if (titles.length === 0) {
        await client.sendMessage({ chatId, text: "Send at least one title." });
        return { handled: true };
      }
      draft = {
        ...draft,
        preferences: { ...draft.preferences, titles },
      };
      await saveSession(db, user.id, "ask_locations", draft);
      await client.sendMessage({
        chatId,
        text: [
          "<b>Step 2/5 — Locations</b>",
          "Comma-separated (e.g. New York, NY, Remote - US).",
        ].join("\n"),
      });
      return { handled: true };
    }
    case "ask_locations": {
      const locations = parseCommaList(text);
      if (locations.length === 0) {
        await client.sendMessage({ chatId, text: "Send at least one location." });
        return { handled: true };
      }
      draft = {
        ...draft,
        preferences: { ...draft.preferences, locations },
      };
      await saveSession(db, user.id, "ask_workplace", draft);
      await client.sendMessage({
        chatId,
        text: [
          "<b>Step 3/5 — Workplace</b>",
          "Reply with any of: remote, hybrid, onsite (or “any”).",
        ].join("\n"),
      });
      return { handled: true };
    }
    case "ask_workplace": {
      const workplace = parseWorkplace(text);
      draft = {
        ...draft,
        preferences: { ...draft.preferences, ...workplace },
      };
      await saveSession(db, user.id, "ask_salary", draft);
      await client.sendMessage({
        chatId,
        text: ["<b>Step 4/5 — Minimum salary</b>", "Number in USD (e.g. 150000), or “skip”."].join(
          "\n",
        ),
      });
      return { handled: true };
    }
    case "ask_salary": {
      const minimumSalary = parseSalary(text);
      draft = {
        ...draft,
        preferences: {
          ...draft.preferences,
          ...(minimumSalary !== undefined ? { minimumSalary } : {}),
        },
      };
      await saveSession(db, user.id, "ask_authorization", draft);
      await client.sendMessage({
        chatId,
        text: [
          "<b>Step 5/5 — Work authorization</b>",
          "Reply: <code>Country, authorized?, sponsorship now?, sponsorship future?</code>",
          "Example: <code>United States, yes, no, no</code>",
        ].join("\n"),
      });
      return { handled: true };
    }
    case "ask_authorization": {
      const authorization = parseAuthorization(text);
      if (!authorization) {
        await client.sendMessage({
          chatId,
          text: "Couldn’t parse that. Example: <code>United States, yes, no, no</code>",
        });
        return { handled: true };
      }
      draft = { ...draft, authorization };
      try {
        const profile = buildCandidateProfileFromDraft(draft);
        await upsertUserProfile(db, user.id, profile);
        await setUserActive(db, user.id, true);
        await clearUserSession(db, user.id);
        await client.sendMessage({
          chatId,
          text: [
            "<b>You’re set.</b>",
            "",
            `Matching titles: ${profile.preferences.titles.join(", ")}`,
            `Locations: ${profile.preferences.locations.join(", ")}`,
            "",
            "You’ll get digests when new roles match (about every 3 hours).",
            "Use /saved and /skipped anytime. /pause to halt digests. /restart to rebuild your profile.",
          ].join("\n"),
        });
      } catch (error) {
        await client.sendMessage({
          chatId,
          text: `Couldn’t finalize profile: ${errorMessage(error)}\nTry /restart.`,
        });
      }
      return { handled: true };
    }
    default:
      await startOnboarding(db, client, user, chatId);
      return { handled: true };
  }
}
