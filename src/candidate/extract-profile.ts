import { z } from "zod";
import type { SearchPreferences } from "./preferences";
import type { CandidateProfile } from "./profile";
import { parseCandidateProfile } from "./profile";

/** Lenient extraction shape from resume text (prefs filled later in onboarding). */
export const ExtractedResumeSchema = z.object({
  identity: z.object({
    fullName: z.string().min(1),
    email: z.union([z.string().email(), z.literal("")]).optional(),
    phone: z.string().optional(),
    location: z.string().default("Unknown"),
    links: z
      .object({
        website: z.union([z.string().url(), z.literal("")]).optional(),
        github: z.union([z.string().url(), z.literal("")]).optional(),
        linkedin: z.union([z.string().url(), z.literal("")]).optional(),
      })
      .default({}),
  }),
  experience: z.object({
    totalYears: z.number().nonnegative().default(0),
    currentTitle: z.string().optional(),
    skills: z.array(z.string()).default([]),
    domains: z.array(z.string()).default([]),
    evidence: z
      .array(
        z.object({
          id: z.string(),
          claim: z.string(),
          source: z.string(),
        }),
      )
      .default([]),
  }),
  education: z
    .array(
      z.object({
        institution: z.string(),
        degree: z.string(),
        field: z.string(),
        graduationDate: z.string(),
      }),
    )
    .default([]),
  authorizationHints: z
    .object({
      country: z.string().optional(),
      authorizedToWork: z.boolean().optional(),
      requiresSponsorshipNow: z.boolean().optional(),
      requiresSponsorshipFuture: z.boolean().optional(),
    })
    .optional(),
});

export type ExtractedResume = z.infer<typeof ExtractedResumeSchema>;

export interface OnboardingDraft {
  extracted: ExtractedResume;
  resumeSource: string;
  preferences?: Partial<SearchPreferences>;
  authorization?: {
    country: string;
    authorizedToWork: boolean;
    requiresSponsorshipNow: boolean;
    requiresSponsorshipFuture: boolean;
  };
}

const PROFILE_EXTRACT_SYSTEM = `You extract structured candidate data from resume text for a job-search agent.
Return ONLY valid JSON matching this shape:
{
  "identity": { "fullName": string, "email"?: string, "phone"?: string, "location": string,
    "links": { "website"?: string, "github"?: string, "linkedin"?: string } },
  "experience": { "totalYears": number, "currentTitle"?: string, "skills": string[],
    "domains": string[], "evidence": [{ "id": string, "claim": string, "source": string }] },
  "education": [{ "institution": string, "degree": string, "field": string, "graduationDate": string }],
  "authorizationHints": { "country"?: string, "authorizedToWork"?: boolean,
    "requiresSponsorshipNow"?: boolean, "requiresSponsorshipFuture"?: boolean }
}
Rules:
- Prefer facts present in the resume; do not invent employers or degrees.
- evidence: 3-8 short claims grounded in the resume; id like "ev-1".
- If email/location missing, omit email or set location to "Unknown".
- totalYears: best estimate from dates; 0 if unclear.
- URLs must be absolute https URLs or omitted.`;

export function buildProfileExtractMessages(resumeText: string): {
  system: string;
  user: string;
} {
  return {
    system: PROFILE_EXTRACT_SYSTEM,
    user: `Resume text:\n\n${resumeText}`,
  };
}

export function parseExtractedResume(data: unknown): ExtractedResume {
  const result = ExtractedResumeSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid resume extraction: ${issues}`);
  }
  return result.data;
}

function optionalUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const u = new URL(value);
    if (u.protocol === "http:" || u.protocol === "https:") return u.toString();
  } catch {
    return undefined;
  }
  return undefined;
}

const PLACEHOLDER_EMAIL = "unknown@example.com";

export function buildCandidateProfileFromDraft(draft: OnboardingDraft): CandidateProfile {
  const extracted = draft.extracted;
  const prefs = draft.preferences;
  const auth = draft.authorization;

  if (!prefs?.titles?.length || !prefs.locations?.length) {
    throw new Error("Draft preferences incomplete");
  }
  if (!auth) {
    throw new Error("Draft authorization incomplete");
  }

  const email =
    extracted.identity.email && extracted.identity.email.includes("@")
      ? extracted.identity.email
      : PLACEHOLDER_EMAIL;

  const links = {
    ...(optionalUrl(extracted.identity.links.website)
      ? { website: optionalUrl(extracted.identity.links.website) }
      : {}),
    ...(optionalUrl(extracted.identity.links.github)
      ? { github: optionalUrl(extracted.identity.links.github) }
      : {}),
    ...(optionalUrl(extracted.identity.links.linkedin)
      ? { linkedin: optionalUrl(extracted.identity.links.linkedin) }
      : {}),
  };

  const profile = {
    identity: {
      fullName: extracted.identity.fullName,
      email,
      ...(extracted.identity.phone ? { phone: extracted.identity.phone } : {}),
      location: extracted.identity.location || "Unknown",
      links,
    },
    authorization: {
      country: auth.country,
      authorizedToWork: auth.authorizedToWork,
      requiresSponsorshipNow: auth.requiresSponsorshipNow,
      requiresSponsorshipFuture: auth.requiresSponsorshipFuture,
    },
    experience: {
      totalYears: extracted.experience.totalYears,
      ...(extracted.experience.currentTitle
        ? { currentTitle: extracted.experience.currentTitle }
        : {}),
      skills: extracted.experience.skills,
      domains: extracted.experience.domains,
      evidence:
        extracted.experience.evidence.length > 0
          ? extracted.experience.evidence
          : [
              {
                id: "ev-resume",
                claim: `${extracted.identity.fullName} resume imported for matching.`,
                source: `resume:${draft.resumeSource}`,
              },
            ],
    },
    education: extracted.education,
    preferences: {
      titles: prefs.titles,
      excludedTitles: prefs.excludedTitles ?? [],
      locations: prefs.locations,
      remote: prefs.remote ?? true,
      hybrid: prefs.hybrid ?? true,
      onsite: prefs.onsite ?? false,
      employmentTypes: prefs.employmentTypes ?? ["full_time"],
      ...(prefs.minimumSalary !== undefined ? { minimumSalary: prefs.minimumSalary } : {}),
      excludedCompanies: prefs.excludedCompanies ?? [],
      requiredKeywords: prefs.requiredKeywords ?? [],
      excludedKeywords: prefs.excludedKeywords ?? [],
      preferUsBased: prefs.preferUsBased ?? true,
    },
    answers: {
      work_authorization: {
        value: auth.authorizedToWork
          ? `Authorized to work in ${auth.country}.`
          : `Work authorization for ${auth.country} needs confirmation.`,
        evidenceIds: [],
        sensitive: true,
        requiresApproval: true,
      },
      sponsorship: {
        value:
          auth.requiresSponsorshipNow || auth.requiresSponsorshipFuture
            ? "May require sponsorship now or in the future."
            : "Does not require sponsorship now or in the future.",
        evidenceIds: [],
        sensitive: true,
        requiresApproval: true,
      },
    },
  };

  return parseCandidateProfile(profile);
}

export function renderDraftSummary(draft: OnboardingDraft): string {
  const e = draft.extracted;
  const skills = e.experience.skills.slice(0, 8).join(", ") || "—";
  return [
    `<b>${escapeHtml(e.identity.fullName)}</b>`,
    e.experience.currentTitle ? escapeHtml(e.experience.currentTitle) : null,
    `Location: ${escapeHtml(e.identity.location || "Unknown")}`,
    e.identity.email ? `Email: ${escapeHtml(e.identity.email)}` : null,
    `YOE ~ ${e.experience.totalYears}`,
    `Skills: ${escapeHtml(skills)}`,
    `Source: ${escapeHtml(draft.resumeSource.slice(0, 80))}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
