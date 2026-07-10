import { describe, expect, it } from "vitest";

import type { PermissionMode } from "@zuse/contracts";

import { applyPlanModePrefix, PLAN_MODE_INSTRUCTIONS } from "../src/provider/drivers/planMode.ts";

describe("applyPlanModePrefix", () => {
  it("prepends the plan-mode instructions when plan mode is active", () => {
    const out = applyPlanModePrefix("plan", "fix the bug");
    expect(out).toBe(`${PLAN_MODE_INSTRUCTIONS}\n\n---\n\nfix the bug`);
    expect(out.startsWith(PLAN_MODE_INSTRUCTIONS)).toBe(true);
    expect(out.endsWith("fix the bug")).toBe(true);
  });

  it("passes the prompt through unchanged outside plan mode", () => {
    const modes: ReadonlyArray<PermissionMode> = ["default", "acceptEdits"];
    for (const mode of modes) {
      expect(applyPlanModePrefix(mode, "fix the bug")).toBe("fix the bug");
    }
  });

  it("preserves an empty prompt", () => {
    expect(applyPlanModePrefix("default", "")).toBe("");
    expect(applyPlanModePrefix("plan", "")).toBe(
      `${PLAN_MODE_INSTRUCTIONS}\n\n---\n\n`,
    );
  });
});
