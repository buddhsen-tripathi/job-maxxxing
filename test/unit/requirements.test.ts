import { describe, expect, it } from "vitest";
import { extractJobRequirements } from "../../src/jobs/requirements";
import { stripHtml } from "../../src/shared/http";

const BLOATED = `
About Us
We are a generational company changing how the world works. Join our mission
to ship rockets and also please read our blog.

The Role
You will partner with stakeholders across the org and have fun.

Requirements
- 5+ years of TypeScript and distributed systems
- Experience with PostgreSQL and AWS
- Must be authorized to work in the United States

Nice to have
- Kubernetes

Benefits
Unlimited PTO, 401k match, parental leave, free lunch.

Equal Opportunity
We are an equal opportunity employer and celebrate diversity.
We cannot provide visa sponsorship for this role.
`;

describe("extractJobRequirements", () => {
  it("keeps qualifications and drops marketing, benefits, and EEO", () => {
    const extracted = extractJobRequirements(BLOATED);
    expect(extracted).toContain("5+ years of TypeScript");
    expect(extracted).toContain("PostgreSQL");
    expect(extracted).toContain("Kubernetes");
    expect(extracted).toContain("visa sponsorship");
    expect(extracted).not.toContain("generational company");
    expect(extracted).not.toContain("Unlimited PTO");
    expect(extracted).not.toContain("equal opportunity employer");
    expect(extracted).not.toContain("partner with stakeholders");
  });

  it("recovers sections from a single collapsed HTML blob", () => {
    const collapsed = stripHtml(
      "<p>About Us</p><p>We ship rockets.</p><p>Requirements</p><ul><li>5+ years TypeScript</li></ul><p>Benefits</p><p>Unlimited PTO</p>",
    );
    const extracted = extractJobRequirements(collapsed);
    expect(extracted).toContain("5+ years TypeScript");
    expect(extracted).not.toContain("Unlimited PTO");
    expect(extracted).not.toContain("We ship rockets");
  });

  it("keeps a short posting that has no headings", () => {
    const short = "Build APIs in TypeScript. Distributed systems experience required.";
    expect(extractJobRequirements(short)).toContain("TypeScript");
  });

  it("returns empty for empty input", () => {
    expect(extractJobRequirements("")).toBe("");
  });
});

describe("stripHtml", () => {
  it("preserves list items as separate lines", () => {
    const text = stripHtml("<p>Intro</p><ul><li>Build APIs</li><li>Own AWS</li></ul>");
    expect(text).toContain("Build APIs");
    expect(text).toMatch(/Build APIs\nOwn AWS/);
  });
});
