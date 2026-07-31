import { describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { buildAnswer } from "../../src/applications/answers";
import { selectResumeVariant } from "../../src/applications/prepare";
import { isTerminalStatus, transitionApplication } from "../../src/applications/state-machine";
import { parseCandidateProfile } from "../../src/candidate/profile";
import { AppError } from "../../src/shared/errors";
import { makeJob } from "../helpers";

const profile = parseCandidateProfile(candidateProfileExample);

describe("transitionApplication", () => {
  it("allows the happy path", () => {
    expect(() => transitionApplication("preparing", "prepared")).not.toThrow();
    expect(() => transitionApplication("prepared", "awaiting_review")).not.toThrow();
    expect(() => transitionApplication("awaiting_review", "approved")).not.toThrow();
    expect(() => transitionApplication("approved", "submitting")).not.toThrow();
    expect(() => transitionApplication("submitting", "submitted")).not.toThrow();
  });

  it("rejects invalid transitions", () => {
    expect(() => transitionApplication("preparing", "submitted")).toThrow(AppError);
    expect(() => transitionApplication("submitted", "preparing")).toThrow(AppError);
    expect(() => transitionApplication("approved", "submitted")).toThrow(AppError);
  });

  it("allows retry transitions from failure states", () => {
    expect(() => transitionApplication("preparation_failed", "preparing")).not.toThrow();
    expect(() => transitionApplication("submission_failed", "submitting")).not.toThrow();
  });

  it("marks terminal statuses", () => {
    expect(isTerminalStatus("submitted")).toBe(true);
    expect(isTerminalStatus("submission_blocked")).toBe(true);
    expect(isTerminalStatus("preparing")).toBe(false);
  });
});

describe("buildAnswer", () => {
  const job = makeJob();

  it("copies work authorization verbatim from verified profile answers", async () => {
    const answer = await buildAnswer(
      "Are you authorized to work in the country where this role is located?",
      job,
      profile,
    );
    expect(answer.confidence).toBe("verified");
    expect(answer.answer).toBe(profile.answers.work_authorization?.value);
    expect(answer.requiresApproval).toBe(true);
  });

  it("derives years of experience from the profile", async () => {
    const answer = await buildAnswer(
      "How many years of relevant professional experience do you have?",
      job,
      profile,
    );
    expect(answer.confidence).toBe("derived");
    expect(answer.answer).toContain("6 years");
  });

  it("leaves salary unanswered without explicit configuration", async () => {
    const answer = await buildAnswer("What are your salary expectations?", job, profile);
    expect(answer.confidence).toBe("unknown");
    expect(answer.answer).toBeUndefined();
    expect(answer.requiresApproval).toBe(true);
  });

  it("never answers demographic questions", async () => {
    for (const question of [
      "Do you identify as a protected veteran? (voluntary self-identification)",
      "What is your gender?",
      "Do you have a disability?",
    ]) {
      const answer = await buildAnswer(question, job, profile);
      expect(answer.confidence).toBe("unknown");
      expect(answer.answer).toBeUndefined();
    }
  });

  it("leaves unknown questions unresolved", async () => {
    const answer = await buildAnswer("Describe your experience with COBOL.", job, profile);
    expect(answer.confidence).toBe("unknown");
  });
});

describe("selectResumeVariant", () => {
  it("picks backend-systems for backend roles", () => {
    expect(
      selectResumeVariant(
        makeJob({ title: "Backend Engineer", description: "Own our APIs." }),
        profile,
      ),
    ).toBe("backend-systems");
  });

  it("picks frontend-product for frontend roles", () => {
    expect(
      selectResumeVariant(
        makeJob({ title: "Frontend Engineer", description: "React and design systems." }),
        profile,
      ),
    ).toBe("frontend-product");
  });
});
