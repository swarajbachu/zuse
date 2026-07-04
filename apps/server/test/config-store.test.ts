import { describe, expect, it } from "bun:test";

import { configStoreTestHelpers } from "../src/config-store/layers/config-store-service.ts";

const { coerceSettings } = configStoreTestHelpers;

describe("config-store settings coercion", () => {
  it("preserves opencode as a valid default provider", () => {
    const settings = coerceSettings({
      defaultProviderId: "opencode",
      defaultModelByProvider: {
        opencode: "openai/gpt-5",
      },
    });

    expect(settings.defaultProviderId).toBe("opencode");
    expect(settings.defaultModelByProvider.opencode).toBe("openai/gpt-5");
  });

  it("seeds missing model visibility from catalog defaults", () => {
    const settings = coerceSettings({});

    expect(settings.appearanceMode).toBe("dark");
    expect(settings.modelEnabledByProvider.claude["claude-sonnet-5"]).toBe(
      true,
    );
    expect(settings.modelEnabledByProvider.claude["claude-fable-5"]).toBe(true);
    expect(settings.modelEnabledByProvider.claude["claude-sonnet-4-6"]).toBe(
      false,
    );
    expect(settings.modelEnabledByProvider.codex["gpt-5.5"]).toBe(true);
    expect(settings.modelEnabledByProvider.codex["gpt-5.3-codex"]).toBe(false);
  });

  it("keeps valid model visibility overrides and drops unknown model ids", () => {
    const settings = coerceSettings({
      modelEnabledByProvider: {
        codex: {
          "gpt-5.3-codex": true,
          "not-real": true,
        },
      },
    });

    expect(settings.modelEnabledByProvider.codex["gpt-5.3-codex"]).toBe(true);
    expect(settings.modelEnabledByProvider.codex["not-real"]).toBeUndefined();
  });

  it("preserves valid appearance modes and drops invalid ones", () => {
    expect(coerceSettings({ appearanceMode: "system" }).appearanceMode).toBe(
      "system",
    );
    expect(coerceSettings({ appearanceMode: "light" }).appearanceMode).toBe(
      "light",
    );
    expect(coerceSettings({ appearanceMode: "sepia" }).appearanceMode).toBe(
      "dark",
    );
  });
});
