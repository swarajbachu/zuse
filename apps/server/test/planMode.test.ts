import { describe, expect, it } from "bun:test";

import type { PermissionMode } from "@zuse/wire";

import {
  applyPlanModePrefix,
  buildCodexCollaborationMode,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  PLAN_MODE_INSTRUCTIONS,
} from "../src/provider/drivers/planMode.ts";

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

  it("asks emulated providers for a proposed_plan block", () => {
    expect(PLAN_MODE_INSTRUCTIONS).toContain("<proposed_plan>");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("</proposed_plan>");
    expect(PLAN_MODE_INSTRUCTIONS).toContain("Plan Mode");
  });
});

describe("buildCodexCollaborationMode", () => {
  it("builds plan collaboration mode with codex plan developer instructions", () => {
    expect(
      buildCodexCollaborationMode({
        permissionMode: "plan",
        model: "gpt-5.5",
        effort: "medium",
      }),
    ).toEqual({
      mode: "plan",
      settings: {
        model: "gpt-5.5",
        reasoning_effort: "medium",
        developer_instructions: CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
      },
    });
  });

  it("builds default collaboration mode when leaving plan mode", () => {
    expect(
      buildCodexCollaborationMode({
        permissionMode: "default",
        model: "gpt-5.5",
      }),
    ).toEqual({
      mode: "default",
      settings: {
        model: "gpt-5.5",
        reasoning_effort: "medium",
        developer_instructions: CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      },
    });
  });

  it("maps acceptEdits onto default collaboration mode", () => {
    const mode = buildCodexCollaborationMode({
      permissionMode: "acceptEdits",
      model: "gpt-5.3-codex",
      effort: "high",
    });
    expect(mode.mode).toBe("default");
    expect(mode.settings.reasoning_effort).toBe("high");
    expect(mode.settings.developer_instructions).toBe(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
    );
  });

  it("keeps codex plan instructions decision-complete and proposed_plan tagged", () => {
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      "<collaboration_mode>",
    );
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      "<proposed_plan>",
    );
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain("update_plan");
    expect(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      "request_user_input",
    );
    expect(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS).toContain(
      "Default mode",
    );
  });
});
