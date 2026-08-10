import { describe, expect, it } from "vitest";
import {
  buildCandidateProfileFromDraft,
  type OnboardingDraft,
  parseExtractedResume,
} from "../../src/candidate/extract-profile";
import { extractFirstUrl } from "../../src/resume/fetch";

describe("parseExtractedResume", () => {
  it("accepts a minimal extraction payload", () => {
    const extracted = parseExtractedResume({
      identity: { fullName: "Ada Lovelace", location: "London" },
      experience: { totalYears: 5, skills: ["math"], domains: [], evidence: [] },
      education: [],
    });
    expect(extracted.identity.fullName).toBe("Ada Lovelace");
    expect(extracted.experience.totalYears).toBe(5);
  });
});

describe("buildCandidateProfileFromDraft", () => {
  it("builds a valid CandidateProfile after prefs + auth", () => {
    const draft: OnboardingDraft = {
      resumeSource: "https://example.com/resume.pdf",
      extracted: parseExtractedResume({
        identity: {
          fullName: "Ada Lovelace",
          email: "ada@example.com",
          location: "London",
          links: {},
        },
        experience: {
          totalYears: 8,
          currentTitle: "Engineer",
          skills: ["TypeScript"],
          domains: ["compute"],
          evidence: [{ id: "ev-1", claim: "Built engines", source: "resume" }],
        },
        education: [],
      }),
      preferences: {
        titles: ["Software Engineer"],
        locations: ["Remote - US"],
        remote: true,
        hybrid: false,
        onsite: false,
      },
      authorization: {
        country: "United States",
        authorizedToWork: true,
        requiresSponsorshipNow: false,
        requiresSponsorshipFuture: false,
      },
    };
    const profile = buildCandidateProfileFromDraft(draft);
    expect(profile.identity.fullName).toBe("Ada Lovelace");
    expect(profile.preferences.titles).toEqual(["Software Engineer"]);
    expect(profile.authorization.requiresSponsorshipNow).toBe(false);
  });
});

describe("extractFirstUrl", () => {
  it("pulls the first http(s) URL from free text", () => {
    expect(extractFirstUrl("here https://cdn.example.com/r.pdf thanks")).toBe(
      "https://cdn.example.com/r.pdf",
    );
    expect(extractFirstUrl("no link")).toBeNull();
  });
});

describe("assertSafeResumeUrl", () => {
  it("blocks private and local hosts", async () => {
    const { assertSafeResumeUrl } = await import("../../src/resume/fetch");
    expect(() => assertSafeResumeUrl(new URL("http://127.0.0.1/r.pdf"))).toThrow(/not allowed/);
    expect(() => assertSafeResumeUrl(new URL("http://192.168.1.2/r.pdf"))).toThrow(/not allowed/);
    expect(() => assertSafeResumeUrl(new URL("https://cdn.example.com/r.pdf"))).not.toThrow();
  });
});
