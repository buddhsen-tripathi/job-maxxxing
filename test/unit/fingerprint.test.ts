import { describe, expect, it } from "vitest";
import {
  canonicalizeUrl,
  computeFingerprint,
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
} from "../../src/jobs/fingerprint";

describe("normalizeCompany", () => {
  it("strips suffixes, punctuation, and case", () => {
    expect(normalizeCompany("Example Corp.")).toBe("example");
    expect(normalizeCompany("Acme, Inc.")).toBe("acme");
    expect(normalizeCompany("O'Reilly Media, LLC")).toBe("oreilly media");
    expect(normalizeCompany("  Big   Co  ")).toBe("big");
  });
});

describe("normalizeTitle", () => {
  it("normalizes case and whitespace, keeps meaningful symbols", () => {
    expect(normalizeTitle("  Senior   Software Engineer ")).toBe("senior software engineer");
    expect(normalizeTitle("C++ Developer")).toBe("c++ developer");
  });
});

describe("normalizeLocation", () => {
  it("handles missing locations", () => {
    expect(normalizeLocation(undefined)).toBe("");
    expect(normalizeLocation("New York, NY")).toBe("new york ny");
  });
});

describe("canonicalizeUrl", () => {
  it("strips tracking params and trailing slashes, lowercases host", () => {
    expect(
      canonicalizeUrl("https://Boards.Greenhouse.io/acme/jobs/123/?utm_source=x&b=2&a=1"),
    ).toBe("https://boards.greenhouse.io/acme/jobs/123?a=1&b=2");
  });

  it("strips www and hash", () => {
    expect(canonicalizeUrl("https://www.example.com/careers/#apply")).toBe(
      "https://example.com/careers",
    );
  });

  it("falls back to trimmed lowercase for invalid URLs", () => {
    expect(canonicalizeUrl(" NotAURL ")).toBe("notaurl");
  });
});

describe("computeFingerprint", () => {
  const base = {
    company: "Example Corp",
    title: "Backend Software Engineer",
    location: "New York, NY",
    canonicalUrl: "https://boards.greenhouse.io/example/jobs/4001",
  };

  it("is stable for identical input", async () => {
    const a = await computeFingerprint(base);
    const b = await computeFingerprint(base);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ignores tracking params and cosmetic differences", async () => {
    const a = await computeFingerprint(base);
    const b = await computeFingerprint({
      company: "Example Corp.",
      title: "Backend Software Engineer ",
      location: "New York, NY",
      canonicalUrl: "https://boards.greenhouse.io/example/jobs/4001/?utm_source=newsletter",
    });
    expect(a).toBe(b);
  });

  it("differs when the title differs", async () => {
    const a = await computeFingerprint(base);
    const b = await computeFingerprint({ ...base, title: "Frontend Engineer" });
    expect(a).not.toBe(b);
  });
});
