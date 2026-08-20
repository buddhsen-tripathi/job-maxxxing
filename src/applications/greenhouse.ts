import { z } from "zod";
import { DEMOGRAPHIC_PATTERN } from "./answers";

export interface GreenhouseApplyTarget {
  boardToken: string;
  jobId: string;
}

const BOARD_JOB_RE = /greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i;

export function parseGreenhouseApplyTarget(input: {
  source: string;
  sourceJobId?: string | null;
  applyUrl: string;
  canonicalUrl?: string | null;
}): GreenhouseApplyTarget | null {
  if (input.source !== "greenhouse") return null;
  for (const url of [input.applyUrl, input.canonicalUrl ?? ""]) {
    const match = BOARD_JOB_RE.exec(url);
    if (match?.[1] && match[2]) {
      return { boardToken: match[1], jobId: match[2] };
    }
  }
  const sourceJobId = input.sourceJobId?.trim();
  if (sourceJobId && /^\d+$/.test(sourceJobId)) {
    for (const url of [input.applyUrl, input.canonicalUrl ?? ""]) {
      const tokenMatch = /greenhouse\.io\/([^/?#]+)/i.exec(url);
      const token = tokenMatch?.[1];
      if (token && token !== "jobs" && token !== "embed") {
        return { boardToken: token, jobId: sourceJobId };
      }
    }
  }
  return null;
}

const ValueSchema = z
  .object({
    value: z.union([z.string(), z.number()]).transform(String),
    label: z.string().optional(),
  })
  .passthrough();

const FieldSchema = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    required: z.boolean().optional(),
    values: z.array(ValueSchema).optional(),
  })
  .passthrough();

const QuestionSchema = z
  .object({
    label: z.string().optional(),
    required: z.boolean().optional(),
    fields: z.array(FieldSchema).optional(),
  })
  .passthrough();

const ComplianceSchema = z
  .object({
    type: z.string().optional(),
    questions: z.array(QuestionSchema).optional(),
  })
  .passthrough();

export const GreenhouseQuestionsResponseSchema = z
  .object({
    id: z.union([z.number(), z.string()]).optional(),
    questions: z.array(QuestionSchema).optional(),
    compliance: z.array(ComplianceSchema).optional(),
  })
  .passthrough();

export type GreenhouseQuestionsResponse = z.infer<typeof GreenhouseQuestionsResponseSchema>;

export interface GreenhouseFormField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  demographic: boolean;
  values: Array<{ value: string; label: string }>;
}

function isDemographicLabel(label: string, complianceType?: string): boolean {
  if (complianceType && /eeo|demographic|diversity|equal/i.test(complianceType)) return true;
  return DEMOGRAPHIC_PATTERN.test(label);
}

function flattenQuestion(
  question: z.infer<typeof QuestionSchema>,
  options: { demographic: boolean },
): GreenhouseFormField[] {
  const label = question.label?.trim() || "Question";
  const fields = question.fields ?? [];
  const out: GreenhouseFormField[] = [];
  for (const field of fields) {
    const type = (field.type ?? "input_text").toLowerCase();
    const required = field.required === true || question.required === true;
    out.push({
      name: field.name,
      label,
      type,
      required,
      demographic: options.demographic || isDemographicLabel(label),
      values: (field.values ?? []).map((value) => ({
        value: value.value,
        label: value.label ?? value.value,
      })),
    });
  }
  return out;
}

export function flattenGreenhouseQuestions(
  payload: GreenhouseQuestionsResponse,
): GreenhouseFormField[] {
  const fields: GreenhouseFormField[] = [];
  for (const question of payload.questions ?? []) {
    fields.push(...flattenQuestion(question, { demographic: false }));
  }
  for (const group of payload.compliance ?? []) {
    const demographic = isDemographicLabel(group.type ?? "", group.type);
    for (const question of group.questions ?? []) {
      fields.push(...flattenQuestion(question, { demographic }));
    }
  }
  return fields;
}

export function isResumeField(field: GreenhouseFormField): boolean {
  return field.type.includes("file") && /resume|cv/i.test(`${field.name} ${field.label}`);
}

export function isFileField(field: GreenhouseFormField): boolean {
  return field.type.includes("file");
}

export function greenhouseQuestionsUrl(target: GreenhouseApplyTarget): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.boardToken)}/jobs/${encodeURIComponent(target.jobId)}?questions=true`;
}

export function greenhouseApplyUrl(target: GreenhouseApplyTarget): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(target.boardToken)}/jobs/${encodeURIComponent(target.jobId)}`;
}

export async function fetchGreenhouseQuestions(
  target: GreenhouseApplyTarget,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<GreenhouseFormField[]> {
  const url = greenhouseQuestionsUrl(target);
  const response = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": "job-maxxing/0.1" },
  });
  if (!response.ok) {
    throw new Error(`Greenhouse questions HTTP ${response.status}`);
  }
  const parsed = GreenhouseQuestionsResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error("Greenhouse questions response failed validation");
  }
  return flattenGreenhouseQuestions(parsed.data);
}

export async function submitGreenhouseApplication(
  target: GreenhouseApplyTarget,
  input: {
    fields: Record<string, string>;
    resume: { bytes: Uint8Array; fileName: string; contentType: string };
    fetchImpl?: typeof fetch;
  },
): Promise<{ reference: string }> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const form = new FormData();
  for (const [name, value] of Object.entries(input.fields)) {
    if (value) form.append(name, value);
  }
  const blob = new Blob([input.resume.bytes], {
    type: input.resume.contentType || "application/pdf",
  });
  form.append("resume", blob, input.resume.fileName);

  const response = await fetchImpl(greenhouseApplyUrl(target), {
    method: "POST",
    body: form,
    headers: { "User-Agent": "job-maxxing/0.1" },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Greenhouse apply HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    const body = JSON.parse(text) as { id?: string | number; success?: boolean };
    return { reference: body.id != null ? String(body.id) : "ok" };
  } catch {
    return { reference: "ok" };
  }
}
