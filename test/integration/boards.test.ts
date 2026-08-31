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
  it("caps priority and fills remaining slots with stale standard boards", async () => {
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

    const selected = await selectBoardsForIngest(db, { batchSize: 3, priorityCap: 1 });
    expect(selected).toHaveLength(3);
    // One reserved priority, then fill remaining with least-recent (other priority + never-polled standard)
    expect(selected.filter((b) => b.tier === "priority").length).toBeGreaterThanOrEqual(1);
    expect(selected.some((b) => b.slug === "std-new")).toBe(true);
    expect(selected.some((b) => b.slug === "std-old")).toBe(false);
  });

  it("preserves priority tier on standard upsert", async () => {
    await upsertAtsBoard(db, {
      provider: "ashby",
      slug: "ramp",
      companyName: "Ramp",
      tier: "priority",
    });
    const again = await upsertAtsBoard(db, {
      provider: "ashby",
      slug: "ramp",
      companyName: "Ramp Inc",
      tier: "standard",
      preservePriority: true,
    });
    expect(again.tier).toBe("priority");
    expect(again.company_name).toBe("Ramp Inc");
  });

  it("round-robins providers when filling a mixed catalog", async () => {
    for (const [provider, slug] of [
      ["greenhouse", "gh-1"],
      ["greenhouse", "gh-2"],
      ["greenhouse", "gh-3"],
      ["lever", "lv-1"],
      ["lever", "lv-2"],
      ["ashby", "as-1"],
    ] as const) {
      await upsertAtsBoard(db, {
        provider,
        slug,
        companyName: slug,
        tier: "standard",
      });
    }
    const selected = await selectBoardsForIngest(db, { batchSize: 6, priorityCap: 0 });
    expect(selected).toHaveLength(6);
    expect(selected.map((b) => b.provider).slice(0, 3)).toEqual(["ashby", "greenhouse", "lever"]);
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
