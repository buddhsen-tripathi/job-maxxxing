import { describe, expect, it } from "vitest";
import { parseCallbackData } from "../../src/telegram/callbacks";

describe("parseCallbackData", () => {
  const id = crypto.randomUUID();

  it("parses supported actions", () => {
    expect(parseCallbackData(`job:shortlist:${id}`)).toEqual({ type: "shortlist", jobId: id });
    expect(parseCallbackData(`job:review:${id}`)).toEqual({ type: "review", jobId: id });
    expect(parseCallbackData(`job:blockconfirm:${id}`)).toEqual({
      type: "blockconfirm",
      jobId: id,
    });
  });

  it("rejects URLs, arbitrary text, and unknown actions", () => {
    expect(parseCallbackData("https://evil.example.com")).toBeNull();
    expect(parseCallbackData("job:delete:123")).toBeNull();
    expect(parseCallbackData(`job:shortlist:not-a-uuid`)).toBeNull();
    expect(parseCallbackData("")).toBeNull();
  });
});
