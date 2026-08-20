import type { CandidateProfile } from "../candidate/profile";
import type { GreenhouseFormField } from "./greenhouse";
import { isFileField, isResumeField } from "./greenhouse";

export interface ApplyFieldState {
  name: string;
  label: string;
  type: string;
  required: boolean;
  demographic: boolean;
  isResume: boolean;
  skip: boolean;
  value?: string;
  options?: Array<{ value: string; label: string }>;
}

export interface ApplyDraft {
  jobId: string;
  applicationId: string;
  boardToken: string;
  sourceJobId: string;
  fileName: string;
  fields: ApplyFieldState[];
}

export function answerKeyForField(name: string): string {
  return `gh:${name}`;
}

export function splitFullName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? fullName.trim();
  const last = parts.length > 1 ? parts.slice(1).join(" ") : first;
  return { first, last };
}

function fromAnswers(profile: CandidateProfile, field: GreenhouseFormField): string | undefined {
  const direct =
    profile.answers[field.name]?.value ?? profile.answers[answerKeyForField(field.name)]?.value;
  if (direct) return direct;
  const byLabel = Object.entries(profile.answers).find(
    ([key, answer]) => key.toLowerCase() === field.label.toLowerCase() && answer.value,
  );
  return byLabel?.[1]?.value;
}

export function matchSelectValue(
  field: Pick<GreenhouseFormField, "values">,
  raw: string,
): string | undefined {
  if (field.values.length === 0) return raw;
  const lower = raw.trim().toLowerCase();
  const exact = field.values.find(
    (option) => option.label.toLowerCase() === lower || option.value.toLowerCase() === lower,
  );
  if (exact) return exact.value;
  const contains = field.values.find(
    (option) =>
      option.label.toLowerCase().includes(lower) || lower.includes(option.label.toLowerCase()),
  );
  return contains?.value;
}

function mappedOrUndefined(
  field: GreenhouseFormField,
  raw: string | undefined,
): string | undefined {
  if (!raw) return undefined;
  if (field.values.length === 0) return raw;
  return matchSelectValue(field, raw);
}

export function valueFromProfile(
  field: GreenhouseFormField,
  profile: CandidateProfile,
): string | undefined {
  const stored = mappedOrUndefined(field, fromAnswers(profile, field));
  if (stored) return stored;
  // Never invent EEO / demographic answers; only reuse what the user already gave.
  if (field.demographic) return undefined;

  const name = field.name.toLowerCase();
  const label = field.label.toLowerCase();
  const { first, last } = splitFullName(profile.identity.fullName);

  if (name === "first_name" || label === "first name") return first;
  if (name === "last_name" || label === "last name") return last;
  if (name === "email" || /\bemail\b/.test(label)) return profile.identity.email;
  if (name === "phone" || /\bphone\b/.test(label)) return profile.identity.phone;
  if (name.includes("linkedin") || label.includes("linkedin"))
    return profile.identity.links.linkedin;
  if (name.includes("github") || label.includes("github")) return profile.identity.links.github;
  if (name.includes("website") || label.includes("portfolio") || label.includes("personal site")) {
    return profile.identity.links.website;
  }
  if (name === "location" || label === "location" || label.includes("city")) {
    return profile.identity.location;
  }

  if (/authorized to work|work authorization|legally authorized/i.test(label)) {
    return mappedOrUndefined(field, profile.authorization.authorizedToWork ? "Yes" : "No");
  }
  if (/sponsor/i.test(label)) {
    const needs =
      profile.authorization.requiresSponsorshipNow ||
      profile.authorization.requiresSponsorshipFuture;
    return mappedOrUndefined(field, needs ? "Yes" : "No");
  }
  if (/years of (experience|relevant)/i.test(label)) {
    return String(profile.experience.totalYears);
  }

  return undefined;
}

export function initialApplyFields(
  formFields: GreenhouseFormField[],
  profile: CandidateProfile,
): { fields: ApplyFieldState[]; blockingFile?: string } {
  const fields: ApplyFieldState[] = [];
  for (const field of formFields) {
    if (isResumeField(field)) {
      fields.push({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        demographic: field.demographic,
        isResume: true,
        skip: false,
        ...(field.values.length > 0 ? { options: field.values } : {}),
      });
      continue;
    }
    if (isFileField(field)) {
      if (field.required) {
        return { fields: [], blockingFile: field.label };
      }
      fields.push({
        name: field.name,
        label: field.label,
        type: field.type,
        required: false,
        demographic: field.demographic,
        isResume: false,
        skip: true,
        ...(field.values.length > 0 ? { options: field.values } : {}),
      });
      continue;
    }

    const value = valueFromProfile(field, profile);
    const skip = !value && !field.required;
    fields.push({
      name: field.name,
      label: field.label,
      type: field.type,
      required: field.required,
      demographic: field.demographic,
      isResume: false,
      skip: Boolean(skip),
      ...(value ? { value } : {}),
      ...(field.values.length > 0 ? { options: field.values } : {}),
    });
  }
  return { fields };
}

export function nextFieldToAsk(fields: ApplyFieldState[]): ApplyFieldState | undefined {
  return fields.find((field) => !field.skip && !field.isResume && !field.value && field.required);
}

export function filledFieldMap(fields: ApplyFieldState[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    if (field.isResume || field.skip || !field.value) continue;
    out[field.name] = field.value;
  }
  return out;
}
