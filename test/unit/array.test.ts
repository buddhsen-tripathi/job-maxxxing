import { describe, expect, it } from "vitest";
import { interleaveByProvider } from "../../src/db/repositories/boards";
import { chunkArray } from "../../src/shared/array";

describe("chunkArray", () => {
  it("splits items into fixed-size groups", () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 3)).toEqual([]);
  });
});

describe("interleaveByProvider", () => {
  it("round-robins ATS providers instead of returning a greenhouse block", () => {
    const boards = [
      { provider: "greenhouse", slug: "a" },
      { provider: "greenhouse", slug: "b" },
      { provider: "greenhouse", slug: "c" },
      { provider: "lever", slug: "d" },
      { provider: "lever", slug: "e" },
      { provider: "ashby", slug: "f" },
    ];
    expect(interleaveByProvider(boards).map((b) => b.provider)).toEqual([
      "greenhouse",
      "lever",
      "ashby",
      "greenhouse",
      "lever",
      "greenhouse",
    ]);
  });
});
