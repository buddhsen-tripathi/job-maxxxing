import { describe, expect, it } from "vitest";
import { parseBotCommand } from "../../src/telegram/commands";

describe("parseBotCommand", () => {
  it("parses shortlists aliases", () => {
    expect(parseBotCommand("/shortlists")).toEqual({ type: "shortlists" });
    expect(parseBotCommand("/shortlist")).toEqual({ type: "shortlists" });
    expect(parseBotCommand("/saved")).toEqual({ type: "shortlists" });
    expect(parseBotCommand("/links")).toEqual({ type: "shortlists" });
    expect(parseBotCommand("/shortlists@jmaxxxingbot")).toEqual({ type: "shortlists" });
  });

  it("parses help and skipped", () => {
    expect(parseBotCommand("/help")).toEqual({ type: "help" });
    expect(parseBotCommand("/start")).toEqual({ type: "help" });
    expect(parseBotCommand("/skipped")).toEqual({ type: "skipped" });
  });

  it("parses pause and resume aliases", () => {
    expect(parseBotCommand("/pause")).toEqual({ type: "pause" });
    expect(parseBotCommand("/stop")).toEqual({ type: "pause" });
    expect(parseBotCommand("/resume")).toEqual({ type: "resume" });
    expect(parseBotCommand("/unpause")).toEqual({ type: "resume" });
  });

  it("returns null for non-commands and unknown for bad slash cmds", () => {
    expect(parseBotCommand("hello")).toBeNull();
    expect(parseBotCommand("/nope")).toEqual({ type: "unknown", raw: "/nope" });
  });
});
