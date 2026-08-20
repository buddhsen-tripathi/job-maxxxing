import { upsertUserResume } from "../db/repositories/user-resumes";

export function resumeObjectKey(userId: string): string {
  return `users/${userId}/resume`;
}

export function resumeFileName(sourceLabel: string, contentType: string): string {
  try {
    const url = new URL(sourceLabel);
    const base = url.pathname.split("/").filter(Boolean).at(-1);
    if (base && /\.[a-z0-9]{2,8}$/i.test(base) && base.length <= 80) return base;
  } catch {
    // not a URL
  }
  const trimmed = sourceLabel.trim();
  if (trimmed && !trimmed.includes("://") && trimmed.length <= 80 && /\S/.test(trimmed)) {
    const base = trimmed.split("/").filter(Boolean).at(-1) ?? trimmed;
    if (base.length <= 80) return base;
  }
  return contentType.toLowerCase().includes("pdf") ? "resume.pdf" : "resume.txt";
}

export async function putUserResume(
  bucket: R2Bucket,
  userId: string,
  bytes: Uint8Array,
  meta: { contentType: string; fileName: string },
): Promise<string> {
  const key = resumeObjectKey(userId);
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: meta.contentType },
    customMetadata: { fileName: meta.fileName },
  });
  return key;
}

export async function persistResumeFile(
  db: D1Database,
  bucket: R2Bucket,
  userId: string,
  input: { bytes: Uint8Array; contentType: string; sourceLabel: string },
): Promise<{ r2Key: string; fileName: string; contentType: string }> {
  const fileName = resumeFileName(input.sourceLabel, input.contentType);
  const r2Key = await putUserResume(bucket, userId, input.bytes, {
    contentType: input.contentType,
    fileName,
  });
  await upsertUserResume(db, {
    userId,
    r2Key,
    contentType: input.contentType,
    fileName,
  });
  return { r2Key, fileName, contentType: input.contentType };
}

export async function getUserResumeObject(
  bucket: R2Bucket,
  key: string,
): Promise<{ bytes: Uint8Array; contentType: string; fileName: string } | null> {
  const object = await bucket.get(key);
  if (!object) return null;
  const buffer = await object.arrayBuffer();
  return {
    bytes: new Uint8Array(buffer),
    contentType: object.httpMetadata?.contentType || "application/octet-stream",
    fileName: object.customMetadata?.fileName || "resume.pdf",
  };
}
