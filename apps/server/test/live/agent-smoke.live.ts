import { describe, expect, it } from "bun:test";
import { Effect, Fiber, Layer, Stream } from "effect";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_RUNTIME_MODE,
  type AgentEvent,
  type AgentSessionId,
  type FolderId,
  type PermissionDecision,
  type PermissionKind,
  type ProviderId,
  type StartSessionInput,
} from "@zuse/wire";

import { AttachmentService } from "../../src/attachment/services/attachment-service.ts";
import { startClaudeSession } from "../../src/provider/drivers/claude.ts";
import { startCodexSession } from "../../src/provider/drivers/codex.ts";
import { startGeminiSession } from "../../src/provider/drivers/gemini.ts";
import { startGrokSession } from "../../src/provider/drivers/grok.ts";
import { startOpencodeSession } from "../../src/provider/drivers/opencode.ts";

type LiveProvider = {
  readonly providerId: ProviderId;
  readonly binary: string;
  readonly envToggle: string;
  readonly apiKeyEnv?: string;
  readonly expectsCursor: boolean;
};

const providers: ReadonlyArray<LiveProvider> = [
  {
    providerId: "claude",
    binary: "claude",
    envToggle: "ZUSE_LIVE_CLAUDE",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    expectsCursor: true,
  },
  {
    providerId: "codex",
    binary: "codex",
    envToggle: "ZUSE_LIVE_CODEX",
    apiKeyEnv: "OPENAI_API_KEY",
    expectsCursor: true,
  },
  {
    providerId: "grok",
    binary: "grok",
    envToggle: "ZUSE_LIVE_GROK",
    apiKeyEnv: "GROK_CODE_XAI_API_KEY",
    expectsCursor: true,
  },
  {
    providerId: "gemini",
    binary: "gemini",
    envToggle: "ZUSE_LIVE_GEMINI",
    apiKeyEnv: "GEMINI_API_KEY",
    expectsCursor: true,
  },
  {
    providerId: "cursor",
    binary: "cursor-agent",
    envToggle: "ZUSE_LIVE_CURSOR",
    apiKeyEnv: "CURSOR_API_KEY",
    expectsCursor: true,
  },
  {
    providerId: "opencode",
    binary: "opencode",
    envToggle: "ZUSE_LIVE_OPENCODE",
    expectsCursor: true,
  },
];

const AttachmentServiceTest = Layer.succeed(AttachmentService, {
  upload: () => Effect.die("not used"),
  touch: () => Effect.void,
  read: () => Effect.succeed(null),
  readPath: () => Effect.succeed(null),
});

const which = (binary: string): string | null => {
  const result = spawnSync("bash", ["-lc", `command -v ${binary}`], {
    encoding: "utf8",
  });
  if (result.status !== 0) return null;
  const path = result.stdout.trim();
  return path.length > 0 && existsSync(path) ? path : null;
};

const liveEnabled = (provider: LiveProvider): boolean =>
  process.env.ZUSE_LIVE_AGENT_TESTS === "1" &&
  process.env[provider.envToggle] === "1";

const requestPermission = async (
  _sessionId: AgentSessionId,
  _kind: PermissionKind,
): Promise<PermissionDecision> => ({ _tag: "AllowOnce" });

const startProvider = async (
  provider: LiveProvider,
  input: StartSessionInput,
  cwd: string,
  binaryPath: string,
  apiKey: string | null,
  sessionId: AgentSessionId,
) => {
  switch (provider.providerId) {
    case "claude":
      return startClaudeSession(
        input,
        cwd,
        apiKey,
        binaryPath,
        sessionId,
        requestPermission,
        () => DEFAULT_RUNTIME_MODE,
      );
    case "codex":
      return startCodexSession(
        input,
        cwd,
        apiKey,
        binaryPath,
        sessionId,
        requestPermission,
      );
    case "grok":
      return startGrokSession(
        input,
        cwd,
        apiKey,
        binaryPath,
        sessionId,
        requestPermission,
        () => DEFAULT_RUNTIME_MODE,
      );
    case "gemini":
      return startGeminiSession(
        input,
        cwd,
        apiKey,
        binaryPath,
        sessionId,
        requestPermission,
        () => DEFAULT_RUNTIME_MODE,
      );
    case "cursor":
      const { startCursorSession } =
        await import("../../src/provider/drivers/cursor.ts");
      return startCursorSession(
        input,
        cwd,
        apiKey,
        binaryPath,
        sessionId,
        requestPermission,
        () => DEFAULT_RUNTIME_MODE,
      );
    case "opencode":
      return startOpencodeSession(input, cwd, apiKey, binaryPath, sessionId);
  }
};

const terminalTags = new Set<AgentEvent["_tag"]>([
  "AssistantMessage",
  "ToolResult",
  "Error",
  "Completed",
  "Interrupted",
]);

const runSmoke = async (
  provider: LiveProvider,
): Promise<ReadonlyArray<AgentEvent>> => {
  const dir = mkdtempSync(join(tmpdir(), `zuse-live-${provider.providerId}-`));
  writeFileSync(
    join(dir, "README.md"),
    "# Live fixture\n\nThis repository fixture says fixture-ok.\n",
  );

  const sessionId =
    `live-${provider.providerId}-${Date.now()}` as AgentSessionId;
  const input: StartSessionInput = {
    folderId: "live-fixture-folder" as FolderId,
    providerId: provider.providerId,
    mode: "sdk",
    sessionId,
    cwdOverride: dir,
    permissionMode: "default",
  };
  const binaryPath = which(provider.binary);
  if (binaryPath === null) {
    console.warn(
      `[live-agent] skipping ${provider.providerId}: ${provider.binary} not found`,
    );
    rmSync(dir, { recursive: true, force: true });
    return [];
  }
  const apiKey =
    provider.apiKeyEnv === undefined
      ? null
      : process.env[provider.apiKeyEnv]?.trim() || null;

  const events: AgentEvent[] = [];
  try {
    await Effect.runPromise(
      Effect.gen(function* () {
        const startEffect = yield* Effect.promise(() =>
          startProvider(provider, input, dir, binaryPath, apiKey, sessionId),
        );
        const handle = yield* startEffect;
        const fiber = yield* Stream.runForEach(handle.events, (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ).pipe(Effect.fork);

        yield* handle.send(
          "Read README.md and reply with the exact marker from it. Do not modify files.",
        );

        const deadline = Date.now() + 45_000;
        while (
          Date.now() < deadline &&
          !events.some((event) => terminalTags.has(event._tag))
        ) {
          yield* Effect.sleep("250 millis");
        }

        yield* handle.close().pipe(Effect.catchAll(() => Effect.void));
        yield* Fiber.interrupt(fiber).pipe(Effect.catchAll(() => Effect.void));
      }).pipe(Effect.provide(AttachmentServiceTest)),
    );
    return events;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

describe("live agent smoke tests", () => {
  for (const provider of providers) {
    it(`${provider.providerId} starts, responds, and closes`, async () => {
      if (!liveEnabled(provider)) {
        console.warn(
          `[live-agent] skipping ${provider.providerId}: set ZUSE_LIVE_AGENT_TESTS=1 and ${provider.envToggle}=1`,
        );
        return;
      }

      const events = await runSmoke(provider);
      if (events.length === 0) return;

      expect(events.some((event) => event._tag === "Started")).toBe(true);
      expect(events.some((event) => terminalTags.has(event._tag))).toBe(true);
      if (
        provider.expectsCursor &&
        !events.some((event) => event._tag === "Error")
      ) {
        expect(events.some((event) => event._tag === "SessionCursor")).toBe(
          true,
        );
      }
    }, 60_000);
  }
});
