import { describe, expect, it } from "vitest";

import type { AgentAvailability, ProviderId } from "@zuse/wire";

import {
  filterModelPickerRecents,
  isModelPickerProviderVisible,
} from "../src/lib/model-picker-availability.ts";

const availabilityFor = (
  providerId: ProviderId,
  patch: Partial<AgentAvailability> = {},
): AgentAvailability => ({
  providerId,
  displayName: providerId,
  cliInstalled: true,
  cliLoggedIn: true,
  hasApiKey: false,
  authStatus: "authenticated",
  ...patch,
});

describe("model picker provider visibility", () => {
  it("shows installed authenticated providers", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "claude",
        availability: availabilityFor("claude"),
        providerEnabled: { claude: true },
      }),
    ).toBe(true);
  });

  it("hides unauthenticated providers", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "codex",
        availability: availabilityFor("codex", {
          authStatus: "unauthenticated",
          cliLoggedIn: true,
        }),
        providerEnabled: { codex: true },
      }),
    ).toBe(false);
  });

  it("shows API-key providers even when the CLI account probe is signed out", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "codex",
        availability: availabilityFor("codex", {
          authStatus: "unauthenticated",
          cliLoggedIn: false,
          hasApiKey: true,
        }),
        providerEnabled: { codex: true },
      }),
    ).toBe(true);
  });

  it("does not collapse the picker before availability has loaded", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "claude",
        availability: undefined,
        providerEnabled: { claude: true },
        availabilityLoaded: false,
      }),
    ).toBe(true);
  });

  it("hides missing provider rows after availability has loaded", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "claude",
        availability: undefined,
        providerEnabled: { claude: true },
        availabilityLoaded: true,
      }),
    ).toBe(false);
  });

  it("hides providers whose CLI is not installed", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "grok",
        availability: availabilityFor("grok", {
          cliInstalled: false,
          authStatus: "authenticated",
        }),
        providerEnabled: { grok: true },
      }),
    ).toBe(false);
  });

  it("hides disabled providers", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "gemini",
        availability: availabilityFor("gemini"),
        providerEnabled: { gemini: false },
      }),
    ).toBe(false);
  });

  it("allows legacy usable login signals when auth is inconclusive", () => {
    expect(
      isModelPickerProviderVisible({
        providerId: "cursor",
        availability: availabilityFor("cursor", {
          authStatus: "unknown",
          cliLoggedIn: true,
        }),
        providerEnabled: { cursor: true },
      }),
    ).toBe(true);
  });

  it("filters recents from hidden providers", () => {
    const recents = [
      { providerId: "claude" as const, modelId: "a" },
      { providerId: "codex" as const, modelId: "b" },
      { providerId: "gemini" as const, modelId: "c" },
    ];

    expect(
      filterModelPickerRecents(
        recents,
        new Set<ProviderId>(["claude", "gemini"]),
      ),
    ).toEqual([
      { providerId: "claude", modelId: "a" },
      { providerId: "gemini", modelId: "c" },
    ]);
  });
});
