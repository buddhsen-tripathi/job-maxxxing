import { describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import { parseCandidateProfile } from "../../src/candidate/profile";
import { applyHardFilters, type FilterContext, maxYearsRequired } from "../../src/jobs/filters";
import { makeJob, must } from "../helpers";

const profile = parseCandidateProfile(candidateProfileExample);

function makeContext(overrides: Partial<FilterContext> = {}): FilterContext {
  return {
    preferences: profile.preferences,
    profile,
    blockedCompanies: new Set<string>(),
    hasApplied: false,
    previouslySkipped: false,
    ...overrides,
  };
}

describe("maxYearsRequired", () => {
  it("extracts the maximum years requirement", () => {
    expect(maxYearsRequired("5+ years of experience")).toBe(5);
    expect(maxYearsRequired("3 years with Go, 7+ years overall")).toBe(7);
    expect(maxYearsRequired("no numbers here")).toBeNull();
  });
});

describe("applyHardFilters", () => {
  it("passes a well-matched job", () => {
    const result = applyHardFilters(makeJob(), makeContext());
    expect(result.eligible).toBe(true);
  });

  it("rejects blocked companies", () => {
    const result = applyHardFilters(
      makeJob(),
      makeContext({ blockedCompanies: new Set(["example"]) }),
    );
    expect(result).toMatchObject({ eligible: false, reasonCode: "blocked_company" });
  });

  it("rejects preference-excluded companies", () => {
    const context = makeContext();
    context.preferences = { ...context.preferences, excludedCompanies: ["Example Corp."] };
    expect(applyHardFilters(makeJob(), context)).toMatchObject({
      eligible: false,
      reasonCode: "blocked_company",
    });
  });

  it("rejects excluded titles", () => {
    const result = applyHardFilters(makeJob({ title: "Engineering Manager" }), makeContext());
    expect(result).toMatchObject({ eligible: false, reasonCode: "excluded_title" });
  });

  it("rejects excluded keywords", () => {
    const result = applyHardFilters(
      makeJob({ description: "This role requires a security clearance." }),
      makeContext(),
    );
    expect(result).toMatchObject({ eligible: false, reasonCode: "excluded_keyword" });
  });

  it("rejects missing required keywords", () => {
    const context = makeContext();
    context.preferences = { ...context.preferences, requiredKeywords: ["rust"] };
    expect(applyHardFilters(makeJob(), context)).toMatchObject({
      eligible: false,
      reasonCode: "missing_required_keyword",
    });
  });

  it("rejects incompatible workplace types", () => {
    const result = applyHardFilters(makeJob({ workplace_type: "onsite" }), makeContext());
    expect(result).toMatchObject({ eligible: false, reasonCode: "incompatible_workplace_type" });
  });

  it("rejects incompatible employment types", () => {
    const result = applyHardFilters(makeJob({ employment_type: "contract" }), makeContext());
    expect(result).toMatchObject({
      eligible: false,
      reasonCode: "incompatible_employment_type",
    });
  });

  it("rejects unsupported locations for non-remote roles", () => {
    const result = applyHardFilters(
      makeJob({ location: "San Francisco, CA", workplace_type: "onsite" }),
      makeContext(),
    );
    expect(result.eligible).toBe(false);
  });

  it("allows remote roles regardless of location text", () => {
    const result = applyHardFilters(
      makeJob({ location: "Anywhere", workplace_type: "remote" }),
      makeContext(),
    );
    expect(result.eligible).toBe(true);
  });

  it("rejects experience requirements above tolerance", () => {
    const result = applyHardFilters(
      makeJob({ description: "Requires 12+ years of software engineering experience." }),
      makeContext(),
    );
    expect(result).toMatchObject({ eligible: false, reasonCode: "experience_exceeds_tolerance" });
  });

  it("rejects sponsorship mismatch when candidate needs sponsorship", () => {
    const context = makeContext();
    context.profile = structuredClone(profile);
    context.profile.authorization.requiresSponsorshipNow = true;
    const result = applyHardFilters(
      makeJob({ description: "We are unable to provide visa sponsorship." }),
      context,
    );
    expect(result).toMatchObject({ eligible: false, reasonCode: "sponsorship_mismatch" });
  });

  it("rejects closed postings", () => {
    const result = applyHardFilters(
      makeJob({ description: "This position has been filled." }),
      makeContext(),
    );
    expect(result).toMatchObject({ eligible: false, reasonCode: "closed_posting" });
  });

  it("rejects invalid apply URLs", () => {
    const result = applyHardFilters(makeJob({ apply_url: "not a url" }), makeContext());
    expect(result).toMatchObject({ eligible: false, reasonCode: "invalid_apply_url" });
  });

  it("rejects jobs already applied to", () => {
    const result = applyHardFilters(makeJob(), makeContext({ hasApplied: true }));
    expect(result).toMatchObject({ eligible: false, reasonCode: "already_applied" });
  });

  it("rejects previously skipped jobs unless the posting changed", () => {
    expect(applyHardFilters(makeJob(), makeContext({ previouslySkipped: true }))).toMatchObject({
      eligible: false,
      reasonCode: "previously_skipped",
    });
    expect(
      applyHardFilters(
        makeJob(),
        makeContext({ previouslySkipped: true, postingMateriallyChanged: true }),
      ).eligible,
    ).toBe(true);
  });

  it("warns on missing location without rejecting", () => {
    const result = applyHardFilters(makeJob({ location: null }), makeContext());
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(must(result.warnings.find((w) => w.includes("Location")))).toBeDefined();
    }
  });
});
