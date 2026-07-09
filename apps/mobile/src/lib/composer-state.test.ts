import { describe, expect, test } from "bun:test";

import {
  isFreshChat,
  isInterruptVisible,
  nextModelChangeActions,
  type ModelModeSelection,
} from "./composer-state";

const base: ModelModeSelection = {
  providerId: "grok",
  model: "grok-4",
  runtimeMode: "approval-required",
  permissionMode: "default",
};

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

describe("nextModelChangeActions", () => {
  test("switches provider on a fresh chat (grok → claude)", () => {
    const next: ModelModeSelection = {
      ...base,
      providerId: "claude",
      model: "opus",
    };
    expect(nextModelChangeActions(base, next, true)).toEqual([
      { type: "setProvider", providerId: "claude", model: "opus" },
    ]);
  });

  test("ignores a provider change mid-chat", () => {
    const next: ModelModeSelection = {
      ...base,
      providerId: "claude",
      model: "opus",
    };
    expect(nextModelChangeActions(base, next, false)).toEqual([]);
  });

  test("allows a model-only change mid-chat", () => {
    const next: ModelModeSelection = { ...base, model: "grok-4-fast" };
    expect(nextModelChangeActions(base, next, false)).toEqual([
      { type: "setModel", model: "grok-4-fast" },
    ]);
  });

  test("issues runtime and permission changes when they differ", () => {
    const next: ModelModeSelection = {
      ...base,
      runtimeMode: "full-access",
      permissionMode: "plan",
    };
    expect(nextModelChangeActions(base, next, false)).toEqual([
      { type: "setRuntimeMode", runtimeMode: "full-access" },
      { type: "setPermissionMode", permissionMode: "plan" },
    ]);
  });

  test("returns nothing when the selection is unchanged", () => {
    expect(nextModelChangeActions(base, { ...base }, true)).toEqual([]);
    expect(nextModelChangeActions(base, { ...base }, false)).toEqual([]);
  });
});
