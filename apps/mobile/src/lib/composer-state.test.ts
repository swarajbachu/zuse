import { describe, expect, test } from "bun:test";

import { isFreshChat, isInterruptVisible } from "./composer-state";

describe("composer state helpers", () => {
  test("shows interrupt only for active statuses", () => {
    expect(isInterruptVisible("running")).toBe(true);
    expect(isInterruptVisible("booting")).toBe(true);
    expect(isInterruptVisible("idle")).toBe(false);
    expect(isInterruptVisible("error")).toBe(false);
  });

  test("detects fresh chats by user messages", () => {
    expect(isFreshChat([])).toBe(true);
    expect(isFreshChat([{ content: { _tag: "assistant" } }])).toBe(true);
    expect(isFreshChat([{ content: { _tag: "user" } }])).toBe(false);
  });
});
