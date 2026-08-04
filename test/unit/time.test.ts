import { describe, expect, it } from "vitest";
import { utcSixHourSlotKey, utcThreeHourSlotKey } from "../../src/shared/time";

describe("utcThreeHourSlotKey", () => {
  it("buckets hours into 3-hour UTC slots", () => {
    expect(utcThreeHourSlotKey(new Date("2026-08-04T00:00:00.000Z"))).toBe("2026-08-04T00");
    expect(utcThreeHourSlotKey(new Date("2026-08-04T02:59:59.000Z"))).toBe("2026-08-04T00");
    expect(utcThreeHourSlotKey(new Date("2026-08-04T03:00:00.000Z"))).toBe("2026-08-04T03");
    expect(utcThreeHourSlotKey(new Date("2026-08-04T13:00:00.000Z"))).toBe("2026-08-04T12");
    expect(utcThreeHourSlotKey(new Date("2026-08-04T21:30:00.000Z"))).toBe("2026-08-04T21");
  });

  it("differs from the legacy 6-hour slot mid-window", () => {
    const mid = new Date("2026-08-04T15:00:00.000Z");
    expect(utcThreeHourSlotKey(mid)).toBe("2026-08-04T15");
    expect(utcSixHourSlotKey(mid)).toBe("2026-08-04T12");
  });
});
