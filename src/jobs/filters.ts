import type { SearchPreferences } from "../candidate/preferences";
import type { CandidateProfile } from "../candidate/profile";
import type { JobRow } from "../db/schema";
import { normalizeCompany } from "./fingerprint";

export type FilterResult =
  | { eligible: true; warnings: string[] }
  | { eligible: false; reasonCode: string; explanation: string };

export interface FilterContext {
  preferences: SearchPreferences;
  profile: CandidateProfile;
  blockedCompanies: ReadonlySet<string>;
  hasApplied: boolean;
  previouslySkipped: boolean;
  postingMateriallyChanged?: boolean;
  experienceToleranceYears?: number;
}

const NO_SPONSORSHIP =
  /\b(no|not|unable to|cannot|without)\s+(offer\s+|provide\s+)?(visa\s+)?sponsor/i;
const CITIZENSHIP_REQUIRED = /\b(must be a|us|u\.s\.)\s+citizen(ship)?\s+(only|required)\b/i;
const CLOSED_POSTING = /no longer (available|accepting)|position has been filled|job is closed/i;

function containsAny(haystack: string, needles: readonly string[]): string | null {
  const lower = haystack.toLowerCase();
  for (const needle of needles) {
    if (needle.trim() && lower.includes(needle.trim().toLowerCase())) return needle;
  }
  return null;
}

export function maxYearsRequired(description: string): number | null {
  const matches = description.matchAll(/(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi);
  let max: number | null = null;
  for (const match of matches) {
    const years = Number(match[1]);
    if (Number.isFinite(years) && years <= 30 && (max === null || years > max)) {
      max = years;
    }
  }
  return max;
}

export function applyHardFilters(job: JobRow, context: FilterContext): FilterResult {
  const { preferences, profile } = context;
  const warnings: string[] = [];
  const titleAndDescription = `${job.title}\n${job.description}`;

  const normalizedCompany = normalizeCompany(job.company);
  const excludedCompanies = new Set(preferences.excludedCompanies.map(normalizeCompany));
  if (context.blockedCompanies.has(normalizedCompany) || excludedCompanies.has(normalizedCompany)) {
    return {
      eligible: false,
      reasonCode: "blocked_company",
      explanation: `Company "${job.company}" is blocked or excluded.`,
    };
  }

  const excludedTitle = containsAny(job.title, preferences.excludedTitles);
  if (excludedTitle) {
    return {
      eligible: false,
      reasonCode: "excluded_title",
      explanation: `Title matches excluded term "${excludedTitle}".`,
    };
  }

  const excludedKeyword = containsAny(titleAndDescription, preferences.excludedKeywords);
  if (excludedKeyword) {
    return {
      eligible: false,
      reasonCode: "excluded_keyword",
      explanation: `Posting contains excluded keyword "${excludedKeyword}".`,
    };
  }

  if (preferences.requiredKeywords.length > 0) {
    const missing = preferences.requiredKeywords.filter(
      (keyword) => !containsAny(titleAndDescription, [keyword]),
    );
    if (missing.length > 0) {
      return {
        eligible: false,
        reasonCode: "missing_required_keyword",
        explanation: `Posting is missing required keyword(s): ${missing.join(", ")}.`,
      };
    }
  }

  if (CLOSED_POSTING.test(job.description)) {
    return {
      eligible: false,
      reasonCode: "closed_posting",
      explanation: "Posting appears to be closed or filled.",
    };
  }

  try {
    new URL(job.apply_url);
  } catch {
    return {
      eligible: false,
      reasonCode: "invalid_apply_url",
      explanation: `Apply URL is invalid: ${job.apply_url}`,
    };
  }

  if (job.workplace_type && job.workplace_type !== "unknown") {
    const allowed =
      (job.workplace_type === "remote" && preferences.remote) ||
      (job.workplace_type === "hybrid" && preferences.hybrid) ||
      (job.workplace_type === "onsite" && preferences.onsite);
    if (!allowed) {
      return {
        eligible: false,
        reasonCode: "incompatible_workplace_type",
        explanation: `Workplace type "${job.workplace_type}" is not enabled in preferences.`,
      };
    }
  } else {
    warnings.push("Workplace type is unknown.");
  }

  if (
    job.employment_type &&
    !preferences.employmentTypes.includes(
      job.employment_type as SearchPreferences["employmentTypes"][number],
    )
  ) {
    return {
      eligible: false,
      reasonCode: "incompatible_employment_type",
      explanation: `Employment type "${job.employment_type}" is not enabled in preferences.`,
    };
  }

  if (job.location && preferences.locations.length > 0 && job.workplace_type !== "remote") {
    const matches = containsAny(job.location, preferences.locations);
    if (!matches) {
      return {
        eligible: false,
        reasonCode: "unsupported_location",
        explanation: `Location "${job.location}" does not match preferred locations.`,
      };
    }
  }
  if (!job.location) {
    warnings.push("Location is missing.");
  }

  if (profile.authorization.requiresSponsorshipNow && NO_SPONSORSHIP.test(job.description)) {
    return {
      eligible: false,
      reasonCode: "sponsorship_mismatch",
      explanation: "Candidate requires sponsorship and the posting excludes sponsorship.",
    };
  }

  const isUsAuthorized =
    profile.authorization.authorizedToWork &&
    profile.authorization.country.toLowerCase() === "united states";
  if (!isUsAuthorized && CITIZENSHIP_REQUIRED.test(job.description)) {
    return {
      eligible: false,
      reasonCode: "authorization_mismatch",
      explanation: "Posting requires US citizenship and the candidate is not a US citizen.",
    };
  }

  const tolerance = context.experienceToleranceYears ?? 2;
  const requiredYears = maxYearsRequired(job.description);
  if (requiredYears !== null && requiredYears > profile.experience.totalYears + tolerance) {
    return {
      eligible: false,
      reasonCode: "experience_exceeds_tolerance",
      explanation: `Posting asks for ${requiredYears}+ years; candidate has ${profile.experience.totalYears} (tolerance ${tolerance}).`,
    };
  }

  if (context.hasApplied) {
    return {
      eligible: false,
      reasonCode: "already_applied",
      explanation: "An application already exists for this job.",
    };
  }

  if (context.previouslySkipped && !context.postingMateriallyChanged) {
    return {
      eligible: false,
      reasonCode: "previously_skipped",
      explanation: "Job was previously skipped and the posting has not materially changed.",
    };
  }

  if (
    preferences.minimumSalary !== undefined &&
    job.salary_max !== null &&
    job.salary_max < preferences.minimumSalary
  ) {
    warnings.push(
      `Salary max ${job.salary_max} is below preferred minimum ${preferences.minimumSalary}.`,
    );
  }

  return { eligible: true, warnings };
}
