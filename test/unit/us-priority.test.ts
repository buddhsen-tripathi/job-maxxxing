import { describe, expect, it } from "vitest";
import { parseScoreThresholds } from "../../src/config";
import type { Env } from "../../src/env";
import { isLikelyUsJob } from "../../src/jobs/location";
import { chooseDigestJobs, recommendationForScore } from "../../src/jobs/scoring";
import { makeJob } from "../helpers";

describe("isLikelyUsJob", () => {
  it("recognizes US locations", () => {
    expect(isLikelyUsJob({ location: "New York, NY" })).toBe(true);
    expect(isLikelyUsJob({ location: "Remote - United States" })).toBe(true);
    expect(isLikelyUsJob({ location: "San Francisco, CA" })).toBe(true);
    expect(isLikelyUsJob({ location: "Remote - US" })).toBe(true);
  });

  it("recognizes non-US locations", () => {
    expect(isLikelyUsJob({ location: "London, UK" })).toBe(false);
    expect(isLikelyUsJob({ location: "Berlin, Germany" })).toBe(false);
    expect(isLikelyUsJob({ location: "Bangalore, India" })).toBe(false);
    expect(isLikelyUsJob({ location: "Toronto, Canada" })).toBe(false);
    expect(isLikelyUsJob({ location: "Remote - EMEA" })).toBe(false);
  });

  it("treats unknown or generic remote locations as neutral (US-ok)", () => {
    expect(isLikelyUsJob({ location: null })).toBe(true);
    expect(isLikelyUsJob({ location: "Remote" })).toBe(true);
  });
});

describe("parseScoreThresholds", () => {
  const env = {} as Env;

  it("defaults to 85/60", () => {
    expect(parseScoreThresholds(env)).toEqual({ strongMatch: 85, review: 60 });
  });

  it("parses configured values", () => {
    expect(
      parseScoreThresholds({
        SCORE_STRONG_MATCH_THRESHOLD: "90",
        SCORE_REVIEW_THRESHOLD: "65",
      } as Env),
    ).toEqual({ strongMatch: 90, review: 65 });
  });

  it("rejects invalid or inverted thresholds", () => {
    expect(() => parseScoreThresholds({ SCORE_REVIEW_THRESHOLD: "abc" } as Env)).toThrow(
      /SCORE_REVIEW_THRESHOLD/,
    );
    expect(() =>
      parseScoreThresholds({
        SCORE_STRONG_MATCH_THRESHOLD: "50",
        SCORE_REVIEW_THRESHOLD: "60",
      } as Env),
    ).toThrow(/greater than/);
  });
});

describe("default thresholds", () => {
  it("treats 60 as the review cutoff", () => {
    expect(recommendationForScore(60)).toBe("review");
    expect(recommendationForScore(59)).toBe("skip");
    expect(recommendationForScore(85)).toBe("strong_match");
  });
});

describe("chooseDigestJobs US prioritization", () => {
  const mk = (total: number, location: string | null) => ({
    job: makeJob({ location }),
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

  it("sorts US-based jobs first, then by score", () => {
    const digest = chooseDigestJobs(
      [mk(90, "Berlin, Germany"), mk(70, "New York, NY"), mk(80, "London, UK")],
      { strongMatch: 85, review: 60 },
      { preferUsBased: true },
    );
    expect(digest.map((d) => d.job.location)).toEqual([
      "New York, NY",
      "Berlin, Germany",
      "London, UK",
    ]);
  });

  it("sorts purely by score when US preference is off", () => {
    const digest = chooseDigestJobs(
      [mk(70, "New York, NY"), mk(90, "Berlin, Germany")],
      { strongMatch: 85, review: 60 },
      { preferUsBased: false },
    );
    expect(digest.map((d) => d.score.totalScore)).toEqual([90, 70]);
  });

  it("includes jobs scoring 60+ by default", () => {
    const digest = chooseDigestJobs([mk(60, null), mk(59, null)], undefined, {});
    expect(digest.map((d) => d.score.totalScore)).toEqual([60]);
  });
});
