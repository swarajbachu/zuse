import type { AgentAvailability } from "@zuse/wire";
import { describe, expect, test } from "vitest";

import { availableProviderIds, reasoningValueForModel } from "./model-options";

const entry = (
  providerId: AgentAvailability["providerId"],
  overrides: Partial<AgentAvailability> = {},
): AgentAvailability => ({
  providerId,
  displayName: providerId,
  cliInstalled: true,
  cliLoggedIn: true,
  hasApiKey: false,
  ...overrides,
});

describe("availableProviderIds", () => {
  test("returns null (no filtering) for null/undefined availability", () => {
    expect(availableProviderIds(null)).toBeNull();
    expect(availableProviderIds(undefined)).toBeNull();
  });

  test("keeps ready and warning providers, drops error/disabled", () => {
    const availability: AgentAvailability[] = [
      entry("codex", { status: "ready" }),
      entry("claude", { status: "warning" }),
      entry("grok", { status: "error" }),
      entry("gemini", { status: "disabled" }),
    ];
    expect(availableProviderIds(availability)).toEqual(["codex", "claude"]);
  });

  test("falls back to cliInstalled when status is missing", () => {
    const availability: AgentAvailability[] = [
      entry("codex", { cliInstalled: true }),
      entry("claude", { cliInstalled: false }),
    ];
    expect(availableProviderIds(availability)).toEqual(["codex"]);
  });

  test("returns an empty list when nothing is available", () => {
    expect(availableProviderIds([entry("codex", { status: "error" })])).toEqual(
      [],
    );
  });
});

describe("reasoningValueForModel", () => {
  test("falls back to the model default when a stored effort is unsupported", () => {
    expect(
      reasoningValueForModel("codex", "gpt-5.5", { reasoning: "ultra" }),
    ).toMatchObject({ value: "medium", label: "Medium" });
  });
});
