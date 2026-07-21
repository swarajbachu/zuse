import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserSend } from "@zuse/agents/drivers/browser-tools";
import { startClaudeSession } from "@zuse/agents/drivers/claude";
import { startCodexSession } from "@zuse/agents/drivers/codex";
import { startGeminiSession } from "@zuse/agents/drivers/gemini";
import { startGrokSession } from "@zuse/agents/drivers/grok";
import { startOpencodeSession } from "@zuse/agents/drivers/opencode";
import { AttachmentService } from "@zuse/agents/kernel/attachment-service";
import {
	type AgentEvent,
	type AgentSessionId,
	DEFAULT_RUNTIME_MODE,
	type FolderId,
	type PermissionDecision,
	type PermissionKind,
	type ProviderId,
	type StartSessionInput,
} from "@zuse/contracts";
import { Effect, Fiber, Layer, Stream } from "effect";
import { describe, expect, it } from "vitest";

type LiveProvider = {
	readonly providerId: ProviderId;
	readonly binary: string;
	readonly envToggle: string;
	readonly apiKeyEnv?: string;
	readonly expectsCursor: boolean;
	readonly timeoutMs?: number;
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
		binary: "bundled SDK",
		envToggle: "ZUSE_LIVE_CURSOR",
		apiKeyEnv: "CURSOR_API_KEY",
		expectsCursor: true,
		timeoutMs: 120_000,
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
	saveText: () => Effect.die("not used"),
	read: () => Effect.succeed(null),
	readPath: () => Effect.succeed(null),
});

const browserSend: BrowserSend = async () => ({
	id: "live-smoke",
	ok: false,
	error: "Browser unavailable in live smoke.",
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
				() => DEFAULT_RUNTIME_MODE,
				browserSend,
				which("bun") ?? "bun",
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
				browserSend,
				null,
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
				browserSend,
				which("bun") ?? "bun",
			);
		case "cursor": {
			if (apiKey === null) {
				throw new Error("API key required for this live provider smoke test");
			}
			const { startCursorSession } = await import(
				"@zuse/agents/drivers/cursor"
			);
			return startCursorSession(input, cwd, apiKey, sessionId);
		}
		case "opencode":
			return startOpencodeSession(input, cwd, [], binaryPath, sessionId);
	}
};

const terminalTags = new Set<AgentEvent["_tag"]>([
	"AssistantMessage",
	"ToolResult",
	"Error",
	"Completed",
	"Interrupted",
]);

const runFinishedTags = new Set<AgentEvent["_tag"]>([
	"Error",
	"Completed",
	"Interrupted",
]);

type SmokeResult =
	| {
			readonly _tag: "Ran";
			readonly events: ReadonlyArray<AgentEvent>;
			readonly eventTimes: ReadonlyArray<number>;
			readonly timedOut: boolean;
	  }
	| { readonly _tag: "Skipped"; readonly reason: string };

const errorMessage = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const skippableLiveFailureReason = (
	provider: LiveProvider,
	cause: unknown,
): string | null => {
	const reason = errorMessage(cause);
	if (
		/auth|authentication|authorization|required|login|sign in|api key|quota|rate limit|billing|unsupported|no longer supported/i.test(
			reason,
		)
	) {
		return `${provider.providerId} environment is not live-test ready: ${reason}`;
	}
	return null;
};

const runSmoke = async (provider: LiveProvider): Promise<SmokeResult> => {
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
	const binaryPath =
		provider.providerId === "cursor" ? "" : which(provider.binary);
	if (binaryPath === null) {
		rmSync(dir, { recursive: true, force: true });
		return {
			_tag: "Skipped",
			reason: `${provider.binary} not found`,
		};
	}
	const apiKey =
		provider.apiKeyEnv === undefined
			? null
			: process.env[provider.apiKeyEnv]?.trim() || null;

	const events: AgentEvent[] = [];
	const eventTimes: number[] = [];
	try {
		const completed = await Effect.runPromise(
			Effect.gen(function* () {
				const startEffect = yield* Effect.promise(() =>
					startProvider(provider, input, dir, binaryPath, apiKey, sessionId),
				);
				const handle = yield* startEffect;
				const fiber = yield* Stream.runForEach(handle.events, (event) =>
					Effect.sync(() => {
						events.push(event);
						eventTimes.push(Date.now());
					}),
				).pipe(Effect.forkChild);

				yield* handle.send(
					"Read README.md and reply with the exact marker from it. Do not modify files.",
				);

				const deadline = Date.now() + (provider.timeoutMs ?? 60_000);
				while (
					Date.now() < deadline &&
					!events.some((event) => runFinishedTags.has(event._tag))
				) {
					yield* Effect.sleep("250 millis");
				}
				const sawTerminal = events.some((event) =>
					runFinishedTags.has(event._tag),
				);

				yield* handle.close().pipe(Effect.catch(() => Effect.void));
				yield* Fiber.interrupt(fiber).pipe(Effect.catch(() => Effect.void));
				return sawTerminal;
			}).pipe(Effect.provide(AttachmentServiceTest)),
		);
		return { _tag: "Ran", events, eventTimes, timedOut: !completed };
	} catch (cause) {
		const skipReason = skippableLiveFailureReason(provider, cause);
		if (skipReason !== null) {
			return { _tag: "Skipped", reason: skipReason };
		}
		throw cause;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

describe("live agent smoke tests", () => {
	for (const provider of providers) {
		it(
			`${provider.providerId} starts, responds, and closes`,
			async () => {
				if (!liveEnabled(provider)) {
					console.warn(
						`[live-agent] skipping ${provider.providerId}: set ZUSE_LIVE_AGENT_TESTS=1 and ${provider.envToggle}=1`,
					);
					return;
				}

				const result = await runSmoke(provider);
				if (result._tag === "Skipped") {
					console.warn(
						`[live-agent] skipping ${provider.providerId}: ${result.reason}`,
					);
					return;
				}
				const { events, eventTimes } = result;

				expect(
					result.timedOut,
					`${provider.providerId} live smoke timed out after ${provider.timeoutMs ?? 60_000}ms without a completed/error/interrupted event; saw ${events.map((event) => event._tag).join(", ")}`,
				).toBe(false);
				expect(events.some((event) => event._tag === "Started")).toBe(true);
				expect(events.some((event) => terminalTags.has(event._tag))).toBe(true);
				if (provider.providerId === "cursor") {
					expect(events.filter((event) => event._tag === "Error")).toEqual([]);
					expect(
						events
							.filter((event) => event._tag === "AssistantMessage")
							.map((event) => event.text)
							.join(""),
					).toContain("fixture-ok");
					const firstAssistant = events.findIndex(
						(event) => event._tag === "AssistantMessage",
					);
					const completed = events.findIndex(
						(event) => event._tag === "Completed",
					);
					const started = events.findIndex((event) => event._tag === "Started");
					expect(firstAssistant).toBeGreaterThanOrEqual(0);
					expect(completed).toBeGreaterThan(firstAssistant);
					expect(
						(eventTimes[firstAssistant] ?? 0) - (eventTimes[started] ?? 0),
					).toBeLessThan(30_000);
					expect(
						(eventTimes[completed] ?? 0) - (eventTimes[firstAssistant] ?? 0),
					).toBeGreaterThan(250);
				}
				if (
					provider.expectsCursor &&
					!events.some((event) => event._tag === "Error")
				) {
					expect(events.some((event) => event._tag === "SessionCursor")).toBe(
						true,
					);
				}
			},
			(provider.timeoutMs ?? 60_000) + 15_000,
		);
	}
});
