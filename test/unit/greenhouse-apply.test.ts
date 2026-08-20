import { describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { initialApplyFields, nextFieldToAsk, valueFromProfile } from "../../src/applications/fill";
import {
  flattenGreenhouseQuestions,
  parseGreenhouseApplyTarget,
} from "../../src/applications/greenhouse";
import { parseCandidateProfile } from "../../src/candidate/profile";
import { resumeFileName } from "../../src/resume/store";
import identityQuestions from "../../src/sources/fixtures/greenhouse-questions.json";
import extraQuestions from "../../src/sources/fixtures/greenhouse-questions-extra.json";
import { parseCallbackData } from "../../src/telegram/callbacks";

const profile = parseCandidateProfile(candidateProfileExample);

describe("parseGreenhouseApplyTarget", () => {
  it("parses boards.greenhouse.io URLs", () => {
    expect(
      parseGreenhouseApplyTarget({
        source: "greenhouse",
        applyUrl: "https://boards.greenhouse.io/exampleco/jobs/4001?utm_source=x",
      }),
    ).toEqual({ boardToken: "exampleco", jobId: "4001" });
  });

  it("parses job-boards.greenhouse.io URLs", () => {
    expect(
      parseGreenhouseApplyTarget({
        source: "greenhouse",
        applyUrl: "https://job-boards.greenhouse.io/acme/jobs/99",
      }),
    ).toEqual({ boardToken: "acme", jobId: "99" });
  });

  it("falls back to sourceJobId when the URL has a board token only", () => {
    expect(
      parseGreenhouseApplyTarget({
        source: "greenhouse",
        sourceJobId: "4001",
        applyUrl: "https://boards.greenhouse.io/exampleco",
      }),
    ).toEqual({ boardToken: "exampleco", jobId: "4001" });
  });

  it("returns null for other sources", () => {
    expect(
      parseGreenhouseApplyTarget({
        source: "lever",
        applyUrl: "https://jobs.lever.co/acme/abc",
      }),
    ).toBeNull();
  });
});

describe("flattenGreenhouseQuestions", () => {
  it("marks resume files and optional linkedin", () => {
    const fields = flattenGreenhouseQuestions(identityQuestions);
    expect(fields.some((f) => f.name === "resume")).toBe(true);
    expect(fields.find((f) => f.name === "linkedin")?.required).toBe(false);
  });
});

describe("initialApplyFields", () => {
  it("fills identity from the profile and does not ask when complete", () => {
    const fields = flattenGreenhouseQuestions(identityQuestions);
    const mapped = initialApplyFields(fields, profile);
    expect(mapped.blockingFile).toBeUndefined();
    expect(nextFieldToAsk(mapped.fields)).toBeUndefined();
    expect(mapped.fields.find((f) => f.name === "first_name")?.value).toBe("Alex");
    expect(mapped.fields.find((f) => f.name === "email")?.value).toBe("alex@example.com");
  });

  it("asks required questions that are not in the profile", () => {
    const fields = flattenGreenhouseQuestions(extraQuestions);
    const mapped = initialApplyFields(fields, profile);
    expect(nextFieldToAsk(mapped.fields)?.name).toBe("question_heard");
  });

  it("maps work authorization yes/no from the profile", () => {
    const field = {
      name: "work_auth",
      label: "Are you authorized to work in the United States?",
      type: "input_text",
      required: true,
      demographic: false,
      values: [
        { value: "1", label: "Yes" },
        { value: "0", label: "No" },
      ],
    };
    expect(valueFromProfile(field, profile)).toBe("1");
  });

  it("does not auto-fill demographic fields", () => {
    const field = {
      name: "gender",
      label: "Gender",
      type: "input_text",
      required: true,
      demographic: true,
      values: [],
    };
    expect(valueFromProfile(field, profile)).toBeUndefined();
  });
});

describe("resumeFileName", () => {
  it("uses the URL basename when it looks like a file", () => {
    expect(resumeFileName("https://cdn.example.com/a/Ada_Resume.pdf", "application/pdf")).toBe(
      "Ada_Resume.pdf",
    );
  });
});

describe("parseCallbackData apply actions", () => {
  const id = crypto.randomUUID();
  it("parses apply/confirm/cancel", () => {
    expect(parseCallbackData(`job:apply:${id}`)).toEqual({ type: "apply", jobId: id });
    expect(parseCallbackData(`job:confirm:${id}`)).toEqual({ type: "confirm", jobId: id });
    expect(parseCallbackData(`job:cancel:${id}`)).toEqual({ type: "cancel", jobId: id });
  });
});
