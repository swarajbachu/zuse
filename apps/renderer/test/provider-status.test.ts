import { beforeEach, describe, expect, it } from "vitest";

import type { AgentAvailability, ProviderId } from "@zuse/wire";

import {
  getProviderSummary,
  isInitialProviderAvailabilityLoading,
} from "../src/lib/provider-status.ts";
import {
  IDLE_PROVIDER_UPDATE_STATE,
  useProvidersStore,
} from "../src/store/providers.ts";

const providers: ReadonlyArray<ProviderId> = [
  "claude",
  "codex",
  "grok",
  "gemini",
  "cursor",
  "opencode",
];

const availabilityFor = (
  providerId: ProviderId,
  displayName: string,
): AgentAvailability => ({
  providerId,
  displayName,
  cliInstalled: true,
  cliLoggedIn: true,
  hasApiKey: false,
  authStatus: "authenticated",
});

describe("provider update state", () => {
  beforeEach(() => {
    useProvidersStore.setState({
      availability: [],
      loading: false,
      availabilityLoaded: false,
      error: null,
      updateStateByProvider: {},
    });
  });

  it("tracks one-click updates by provider", () => {
    useProvidersStore
      .getState()
      .setProviderUpdateState("claude", {
        kind: "running",
        line: "installing Claude",
      });

    const state = useProvidersStore.getState();
    expect(state.updateStateByProvider.claude).toEqual({
      kind: "running",
      line: "installing Claude",
    });
    for (const providerId of providers.filter((p) => p !== "claude")) {
      expect(
        state.updateStateByProvider[providerId] ??
          IDLE_PROVIDER_UPDATE_STATE,
      ).toEqual(IDLE_PROVIDER_UPDATE_STATE);
    }
  });
});

describe("provider availability loading", () => {
  it("only treats global loading as card loading before availability has loaded", () => {
    expect(isInitialProviderAvailabilityLoading(true, false)).toBe(true);
    expect(isInitialProviderAvailabilityLoading(true, true)).toBe(false);
    expect(isInitialProviderAvailabilityLoading(false, false)).toBe(false);
  });

  it("keeps other providers on their availability state during a post-update refresh", () => {
    const codex = availabilityFor("codex", "Codex");
    const summary = getProviderSummary(
      codex,
      true,
      isInitialProviderAvailabilityLoading(true, true),
    );

    expect(summary.statusKey).toBe("ready");
    expect(summary.headline).toBe("Authenticated");
  });

  it("still shows checking for missing provider rows during initial load", () => {
    const summary = getProviderSummary(
      undefined,
      true,
      isInitialProviderAvailabilityLoading(true, false),
    );

    expect(summary.statusKey).toBe("loading");
    expect(summary.headline).toBe("Checking…");
  });
});
