import { describe, expect, it } from "vitest";
import candidateProfileExample from "../../candidate-profile.example.json";
import searchPreferencesExample from "../../search-preferences.example.json";
import { findMissingEvidenceReferences } from "../../src/candidate/evidence";
import { SearchPreferencesSchema } from "../../src/candidate/preferences";
import { parseCandidateProfile } from "../../src/candidate/profile";

describe("candidate profile schema", () => {
  it("accepts the example profile", () => {
    const profile = parseCandidateProfile(candidateProfileExample);
    expect(profile.identity.fullName).toBe("Alex Example");
    expect(profile.preferences.excludedTitles).toContain("Engineering Manager");
  });

  it("rejects invalid email with a readable error", () => {
    const invalid = structuredClone(candidateProfileExample);
    invalid.identity.email = "not-an-email";
    expect(() => parseCandidateProfile(invalid)).toThrow(/identity\.email/);
  });

  it("rejects negative years of experience", () => {
    const invalid = structuredClone(candidateProfileExample);
    invalid.experience.totalYears = -1;
    expect(() => parseCandidateProfile(invalid)).toThrow(/experience\.totalYears/);
  });

  it("rejects invalid employment types", () => {
    const invalid = structuredClone(candidateProfileExample);
    invalid.preferences.employmentTypes = ["freelance"] as unknown as string[];
    expect(() => parseCandidateProfile(invalid)).toThrow(/preferences\.employmentTypes/);
  });
});

describe("search preferences schema", () => {
  it("accepts the example preferences", () => {
    const prefs = SearchPreferencesSchema.parse(searchPreferencesExample);
    expect(prefs.remote).toBe(true);
    expect(prefs.minimumSalary).toBe(150000);
  });

  it("applies defaults for optional arrays", () => {
    const prefs = SearchPreferencesSchema.parse({
      titles: ["Software Engineer"],
      locations: ["Remote"],
      remote: true,
      hybrid: false,
      onsite: false,
      employmentTypes: ["full_time"],
    });
    expect(prefs.excludedCompanies).toEqual([]);
    expect(prefs.excludedKeywords).toEqual([]);
  });
});

describe("evidence references", () => {
  it("finds answers referencing unknown evidence ids", () => {
    const profile = parseCandidateProfile(candidateProfileExample);
    expect(findMissingEvidenceReferences(profile)).toEqual([]);

    const answer = profile.answers.years_experience_typescript;
    if (!answer) throw new Error("missing answer fixture");
    answer.evidenceIds.push("ev-does-not-exist");
    const missing = findMissingEvidenceReferences(profile);
    expect(missing).toEqual([
      { answerKey: "years_experience_typescript", evidenceId: "ev-does-not-exist" },
    ]);
  });
});
