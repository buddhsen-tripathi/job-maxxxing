const COMPANY_SUFFIXES = /\b(inc|llc|llp|ltd|corp|corporation|co|company|gmbh|sas|plc|group)\b/g;

export function normalizeCompany(company: string): string {
  return company
    .toLowerCase()
    .replace(/[.,'’]/g, "")
    .replace(COMPANY_SUFFIXES, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9+/.#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeLocation(location: string | undefined): string {
  if (!location) return "";
  return location
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_cid|mc_eid|ref$|source$|tracking)/i;

export function canonicalizeUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url.trim().toLowerCase();
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  let path = parsed.pathname.replace(/\/+$/, "");
  if (path === "") path = "/";
  const params = [...parsed.searchParams.entries()]
    .filter(([key]) => !TRACKING_PARAMS.test(key))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.map(([k, v]) => `${k}=${v}`).join("&");
  return `https://${host}${path}${query ? `?${query}` : ""}`;
}

export async function computeFingerprint(input: {
  company: string;
  title: string;
  location?: string;
  canonicalUrl: string;
}): Promise<string> {
  const material = [
    normalizeCompany(input.company),
    normalizeTitle(input.title),
    normalizeLocation(input.location),
    canonicalizeUrl(input.canonicalUrl),
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
