import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  boardToSourceEntry,
  markBoardPolled,
  selectBoardsForIngest,
  upsertAtsBoard,
} from "../../src/db/repositories/boards";

const db = env.DB;

beforeEach(async () => {
  await db.prepare("DELETE FROM ats_boards").run();
});

describe("ats_boards repository", () => {
  it("selects all priority boards plus least-recently-polled standard", async () => {
    await upsertAtsBoard(db, {
      provider: "greenhouse",
      slug: "prio-a",
      companyName: "Prio A",
      tier: "priority",
    });
    await upsertAtsBoard(db, {
      provider: "ashby",
      slug: "prio-b",
      companyName: "Prio B",
      tier: "priority",
    });
    const stdOld = await upsertAtsBoard(db, {
      provider: "lever",
      slug: "std-old",
      companyName: "Std Old",
      tier: "standard",
    });
    await upsertAtsBoard(db, {
      provider: "lever",
      slug: "std-new",
      companyName: "Std New",
      tier: "standard",
    });
    await markBoardPolled(db, stdOld.id, "ok", new Date("2026-08-01T00:00:00.000Z"));

    const selected = await selectBoardsForIngest(db, { standardBatchSize: 1 });
    expect(selected.filter((b) => b.tier === "priority")).toHaveLength(2);
    expect(selected.filter((b) => b.tier === "standard")).toHaveLength(1);
    // Never-polled standard should come before the previously polled one
    expect(selected.find((b) => b.tier === "standard")?.slug).toBe("std-new");
  });

  it("maps boards to source entries", () => {
    expect(
      boardToSourceEntry({
        id: "1",
        provider: "ashby",
        slug: "ramp",
        company_name: "Ramp",
        tier: "priority",
        active: 1,
        sector: "fintech",
        last_polled_at: null,
        last_status: null,
        created_at: "",
        updated_at: "",
      }),
    ).toEqual({ source: "ashby", company: "Ramp", boardSlug: "ramp" });
  });
});
