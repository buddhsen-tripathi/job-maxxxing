import { describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { parseCandidateProfile } from "../../src/candidate/profile";
import {
  chooseDigestJobs,
  recommendationForScore,
  ScoreValidationError,
  scoreJob,
  scoreJobs,
  validateScore,
} from "../../src/jobs/scoring";
import { createMockLlmClient, deterministicScore } from "../../src/llm/mock";
import { makeJob } from "../helpers";

const profile = parseCandidateProfile(candidateProfileExample);

describe("recommendationForScore", () => {
  it("maps scores to recommendations using thresholds", () => {
    expect(recommendationForScore(91)).toBe("strong_match");
    expect(recommendationForScore(85)).toBe("strong_match");
    expect(recommendationForScore(60)).toBe("review");
    expect(recommendationForScore(59)).toBe("skip");
    expect(recommendationForScore(60, { strongMatch: 50, review: 40 })).toBe("strong_match");
  });
});

describe("validateScore", () => {
  it("accepts the deterministic mock score", () => {
    const score = deterministicScore(makeJob(), profile);
    expect(validateScore(score, profile)).toEqual(score);
  });

  it("rejects totals that do not equal the component sum", () => {
    const bad = {
      technicalScore: 40,
      experienceScore: 25,
      domainScore: 15,
      locationScore: 10,
      evidenceScore: 10,
      totalScore: 99,
      recommendation: "strong_match",
      reasons: [],
      risks: [],
      evidence: [],
    };
    expect(() => validateScore(bad, profile)).toThrow(ScoreValidationError);
  });

  it("rejects unknown candidate evidence ids", () => {
    const score = deterministicScore(makeJob(), profile);
    const withBadEvidence = {
      ...score,
      evidence: [
        { jobRequirement: "TypeScript", candidateEvidenceId: "ev-fake", assessment: "match" },
      ],
    };
    expect(() => validateScore(withBadEvidence, profile)).toThrow(/unknown evidence id/);
  });

  it("rejects recommendations inconsistent with the total", () => {
    const score = {
      technicalScore: 10,
      experienceScore: 0,
      domainScore: 0,
      locationScore: 0,
      evidenceScore: 0,
      totalScore: 10,
      recommendation: "strong_match" as const,
      reasons: [],
      risks: [],
      evidence: [],
    };
    expect(() => validateScore(score, profile)).toThrow(/inconsistent/);
  });
});

describe("scoreJob", () => {
  it("retries once on malformed output and succeeds", async () => {
    const client = createMockLlmClient({ failTimes: 1 });
    const score = await scoreJob(client, makeJob(), profile);
    expect(client.calls).toBe(2);
    expect(score.totalScore).toBeGreaterThanOrEqual(0);
  });

  it("fails after one retry when output stays invalid", async () => {
    const client = createMockLlmClient({ failTimes: 5 });
    await expect(scoreJob(client, makeJob(), profile)).rejects.toThrow(ScoreValidationError);
    expect(client.calls).toBe(2);
  });
});

describe("scoreJobs", () => {
  it("isolates per-job failures", async () => {
    const good = deterministicScore(makeJob(), profile);
    const client = createMockLlmClient({ scriptedOutputs: [{ bad: true }, { bad: true }, good] });
    const outcome = await scoreJobs([makeJob(), makeJob()], { client, profile, concurrency: 1 });
    expect(outcome.failures).toHaveLength(1);
    expect(outcome.scored).toHaveLength(1);
  });
});

describe("chooseDigestJobs", () => {
  it("keeps only jobs at or above the review threshold, sorted descending", () => {
    const job = makeJob();
    const mk = (total: number) => ({
      job,
      score: {
        technicalScore: total,
        experienceScore: 0,
        domainScore: 0,
        locationScore: 0,
        evidenceScore: 0,
        totalScore: total,
        recommendation: recommendationForScore(total),
        reasons: [],
        risks: [],
        evidence: [],
      },
    });
    const digest = chooseDigestJobs([mk(50), mk(90), mk(75)]);
    expect(digest.map((d) => d.score.totalScore)).toEqual([90, 75]);
  });
});
