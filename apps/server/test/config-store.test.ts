import { afterEach, describe, expect, it } from "bun:test";
import { NodeContext } from "@effect/platform-node";
import { Effect, Layer, ManagedRuntime } from "effect";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { configStoreTestHelpers } from "../src/config-store/layers/config-store-service.ts";
import { ConfigStoreServiceLive } from "../src/config-store/layers/config-store-service.ts";
import { ConfigStoreService } from "../src/config-store/services/config-store-service.ts";
import { AppPaths } from "../src/app-paths.ts";

const { coerceSettings } = configStoreTestHelpers;

const tempDirs: string[] = [];
const originalZuseConfigDir = process.env.ZUSE_CONFIG_DIR;
const originalZuseConfigProfile = process.env.ZUSE_CONFIG_PROFILE;
const originalZuseDevConfig = process.env.ZUSE_DEV_CONFIG;
const originalViteDevServerUrl = process.env.VITE_DEV_SERVER_URL;

const makeRuntime = (userData: string, userConfig: string) => {
  process.env.ZUSE_CONFIG_DIR = userConfig;
  const TestLayer = ConfigStoreServiceLive.pipe(
    Layer.provide(Layer.succeed(AppPaths, { userData })),
    Layer.provide(NodeContext.layer),
  );
  return ManagedRuntime.make(TestLayer);
};

const withRuntime = async <A>(
  fn: (args: {
    run: <X>(eff: Effect.Effect<X, unknown, ConfigStoreService>) => Promise<X>;
    userData: string;
    userConfig: string;
  }) => Promise<A>,
): Promise<A> => {
  const dir = mkdtempSync(join(tmpdir(), "zuse-config-store-"));
  tempDirs.push(dir);
  const userData = join(dir, "user-data");
  const userConfig = join(dir, "home", ".zuse");
  mkdirSync(userData, { recursive: true });
  const runtime = makeRuntime(userData, userConfig);
  const run = <X>(
    eff: Effect.Effect<X, unknown, ConfigStoreService>,
  ): Promise<X> => runtime.runPromise(eff as Effect.Effect<X, unknown, never>);
  try {
    return await fn({ run, userData, userConfig });
  } finally {
    await runtime.dispose();
  }
};

afterEach(() => {
  if (originalZuseConfigDir === undefined) delete process.env.ZUSE_CONFIG_DIR;
  else process.env.ZUSE_CONFIG_DIR = originalZuseConfigDir;
  if (originalZuseConfigProfile === undefined) {
    delete process.env.ZUSE_CONFIG_PROFILE;
  } else process.env.ZUSE_CONFIG_PROFILE = originalZuseConfigProfile;
  if (originalZuseDevConfig === undefined) delete process.env.ZUSE_DEV_CONFIG;
  else process.env.ZUSE_DEV_CONFIG = originalZuseDevConfig;
  if (originalViteDevServerUrl === undefined) {
    delete process.env.VITE_DEV_SERVER_URL;
  } else process.env.VITE_DEV_SERVER_URL = originalViteDevServerUrl;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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
    expect(settings.notchTrayEnabled).toBe(false);
    expect(settings.notchTrayPinned).toBe(false);
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

  it("preserves valid notch tray settings", () => {
    const settings = coerceSettings({
      notchTrayEnabled: true,
      notchTrayPinned: true,
    });

    expect(settings.notchTrayEnabled).toBe(true);
    expect(settings.notchTrayPinned).toBe(true);
  });
});

describe("config-store user JSON storage", () => {
  it("uses a separate dev config directory by default", () => {
    delete process.env.ZUSE_CONFIG_DIR;
    delete process.env.ZUSE_CONFIG_PROFILE;
    delete process.env.ZUSE_DEV_CONFIG;
    delete process.env.VITE_DEV_SERVER_URL;
    expect(basename(configStoreTestHelpers.userConfigDir())).toBe(".zuse");

    process.env.VITE_DEV_SERVER_URL = "http://localhost:5173";
    expect(basename(configStoreTestHelpers.userConfigDir())).toBe(".zuse-dev");
  });

  it("creates global settings and keybindings under ~/.zuse", async () => {
    await withRuntime(async ({ run, userConfig, userData }) => {
      await run(Effect.flatMap(ConfigStoreService, (svc) => svc.getSettings()));
      await run(
        Effect.flatMap(ConfigStoreService, (svc) => svc.getKeybindings()),
      );

      expect(existsSync(join(userConfig, "settings.json"))).toBe(true);
      expect(existsSync(join(userConfig, "keybindings.json"))).toBe(true);
      expect(existsSync(join(userData, "settings.json"))).toBe(false);
      expect(existsSync(join(userData, "keybindings.json"))).toBe(false);
    });
  });

  it("migrates legacy userData settings and keybindings when ~/.zuse is absent", async () => {
    await withRuntime(async ({ run, userConfig, userData }) => {
      writeFileSync(
        join(userData, "settings.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          appearanceMode: "light",
          defaultProviderId: "opencode",
        })}\n`,
        "utf8",
      );
      writeFileSync(
        join(userData, "keybindings.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          rules: [{ key: "cmd+k", command: "new-chat" }],
        })}\n`,
        "utf8",
      );

      const settings = await run(
        Effect.flatMap(ConfigStoreService, (svc) => svc.getSettings()),
      );
      const keybindings = await run(
        Effect.flatMap(ConfigStoreService, (svc) => svc.getKeybindings()),
      );

      expect(settings.appearanceMode).toBe("light");
      expect(settings.defaultProviderId).toBe("opencode");
      expect(keybindings.rules[0]?.key).toBe("cmd+k");
      expect(keybindings.rules[0]?.command).toBe("new-chat");
      expect(existsSync(join(userConfig, "settings.json"))).toBe(true);
      expect(existsSync(join(userConfig, "keybindings.json"))).toBe(true);
    });
  });

  it("prefers existing ~/.zuse files over legacy userData files", async () => {
    await withRuntime(async ({ run, userConfig, userData }) => {
      mkdirSync(userConfig, { recursive: true });
      writeFileSync(
        join(userConfig, "settings.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          appearanceMode: "system",
          defaultProviderId: "codex",
        })}\n`,
        "utf8",
      );
      writeFileSync(
        join(userData, "settings.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          appearanceMode: "light",
          defaultProviderId: "opencode",
        })}\n`,
        "utf8",
      );

      const settings = await run(
        Effect.flatMap(ConfigStoreService, (svc) => svc.getSettings()),
      );

      expect(settings.appearanceMode).toBe("system");
      expect(settings.defaultProviderId).toBe("codex");
    });
  });

  it("writes updates to ~/.zuse and leaves legacy userData settings alone", async () => {
    await withRuntime(async ({ run, userConfig, userData }) => {
      writeFileSync(
        join(userData, "settings.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          appearanceMode: "light",
        })}\n`,
        "utf8",
      );

      await run(
        Effect.flatMap(ConfigStoreService, (svc) =>
          svc.updateSettings({ appearanceMode: "system" }),
        ),
      );

      const current = JSON.parse(
        readFileSync(join(userConfig, "settings.json"), "utf8"),
      ) as { readonly appearanceMode?: string };
      const legacy = JSON.parse(
        readFileSync(join(userData, "settings.json"), "utf8"),
      ) as { readonly appearanceMode?: string };

      expect(current.appearanceMode).toBe("system");
      expect(legacy.appearanceMode).toBe("light");
    });
  });
});
