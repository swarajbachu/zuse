import { execFile } from "node:child_process";
import { chmod, chown, mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ReviewResult, ReviewSnapshot } from "@zuse/contracts";
import { Schema } from "effect";
import { z } from "zod";
import { createNativeReviewFactory } from "./native-adapter.ts";
import { openReviewReader } from "./reader-service.ts";
import { runReviewWithAdapter } from "./worker.ts";

const exec = promisify(execFile);
const Bootstrap = z.object({
	runId: z.string().min(1).max(256),
	attemptId: z.string().min(1).max(256),
	connectionId: z.string().min(1).max(256),
	agentProvider: z.literal("claude"),
	model: z.string().min(1).max(256),
	snapshot: z.object({
		repositoryId: z.number().int().positive(),
		baseRef: z.string().min(1).max(256),
		baseSha: z.string().regex(/^[a-f0-9]{40}$/u),
		headSha: z.string().regex(/^[a-f0-9]{40}$/u),
	}),
	repository: z.object({
		cloneUrl: z
			.string()
			.regex(
				/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/u,
			),
		token: z.string().min(1).max(4096),
	}),
	authHome: z.literal("/run/zuse-review-auth"),
	deadlineMs: z.number().int().positive(),
});
const Heartbeat = z.object({
	continue: z.boolean(),
	deadlineMs: z.number().int().positive(),
});
export interface NativeWorkerRuntimeInput {
	readonly apiOrigin: string;
	readonly attemptId: string;
	readonly bootToken: string;
	readonly executablePath: string;
	readonly workRoot: string;
	readonly signal: AbortSignal;
	readonly workerExecutable: string;
}

/** Admission occurs in the control plane; this executable also requires a valid leased bootstrap. */
export async function runNativeWorkerRuntime(
	input: NativeWorkerRuntimeInput,
): Promise<void> {
	const origin = new URL(input.apiOrigin);
	if (
		origin.protocol !== "https:" ||
		origin.origin !== input.apiOrigin ||
		!/^[A-Za-z0-9_-]{1,256}$/u.test(input.attemptId)
	)
		throw new Error("Invalid worker control origin or attempt");
	const controller = new AbortController();
	const abort = () => controller.abort();
	input.signal.addEventListener("abort", abort, { once: true });
	if (input.signal.aborted) abort();
	const post = async (operation: string, payload: unknown) => {
		const response = await fetch(
			`${origin.origin}/v1/review/attempts/${encodeURIComponent(input.attemptId)}/${operation}`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${input.bootToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(15_000),
				redirect: "error",
			},
		);
		if (!response.ok) throw new Error("Review control request rejected");
		const text = await response.text();
		if (Buffer.byteLength(text) > 64_000)
			throw new Error("Review control response exceeds limit");
		return text ? JSON.parse(text) : null;
	};
	let runRoot: string | undefined;
	let lockHeld = false;
	let timer: ReturnType<typeof setInterval> | undefined;
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let heartbeat: Promise<void> | undefined;
	let cleanupConfirmed = false;
	let result: ReviewResult | undefined;
	let reader: Awaited<ReturnType<typeof openReviewReader>> | undefined;
	let errorCode: string | undefined;
	try {
		if (process.getuid?.() !== 0)
			throw new Error("Review supervisor requires isolated root image");
		await mkdir(input.workRoot, { recursive: true, mode: 0o711 });
		await chmod(input.workRoot, 0o711);
		// Fail closed after crashes: infrastructure must reap the prior supervisor before recovery.
		await mkdir(join(input.workRoot, "active"), { mode: 0o700 });
		lockHeld = true;
		const boot = Bootstrap.parse(await post("bootstrap", {}));
		if (
			boot.attemptId !== input.attemptId ||
			boot.deadlineMs - Date.now() <= 45_000
		)
			throw new Error("Review attempt expired");
		deadlineTimer = setTimeout(
			abort,
			Math.min(boot.deadlineMs - Date.now() - 45_000, 3_555_000),
		);
		const pulse = async () => {
			const status = Heartbeat.parse(await post("heartbeat", {}));
			if (!status.continue || status.deadlineMs <= Date.now())
				controller.abort();
			controller.signal.throwIfAborted();
		};
		await pulse();
		timer = setInterval(() => {
			if (!heartbeat)
				heartbeat = pulse()
					.catch(abort)
					.finally(() => {
						heartbeat = undefined;
					});
		}, 5_000);
		runRoot = await mkdtemp(join(input.workRoot, "run-"));
		await chmod(runRoot, 0o711);
		const repoRoot = join(runRoot, "repository");
		const trustedCwd = join(runRoot, "sessions");
		await mkdir(trustedCwd, { mode: 0o700 });
		await chown(trustedCwd, 1000, 1000);
		const git = async (args: string[], token?: string) => {
			const response = await exec(
				"git",
				[
					"-c",
					"core.hooksPath=/dev/null",
					"-c",
					"core.fsmonitor=false",
					...args,
				],
				{
					maxBuffer: 4_000_000,
					timeout: 120_000,
					signal: controller.signal,
					env: {
						PATH: "/usr/bin:/bin",
						HOME: trustedCwd,
						GIT_CONFIG_NOSYSTEM: "1",
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_TERMINAL_PROMPT: "0",
						GIT_NO_REPLACE_OBJECTS: "1",
						...(token
							? {
									GIT_CONFIG_COUNT: "1",
									GIT_CONFIG_KEY_0: "http.extraHeader",
									GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
								}
							: {}),
					},
				},
			);
			return response.stdout.trim();
		};
		await git(["init", "--bare", repoRoot]);
		await git(
			[
				"-C",
				repoRoot,
				"fetch",
				"--no-tags",
				"--no-recurse-submodules",
				boot.repository.cloneUrl,
				boot.snapshot.baseSha,
				boot.snapshot.headSha,
			],
			boot.repository.token,
		);
		// No token is written into git config or exposed to the native model process.
		boot.repository.token = "";
		const mergeBaseSha = await git([
			"-C",
			repoRoot,
			"merge-base",
			"--all",
			boot.snapshot.baseSha,
			boot.snapshot.headSha,
		]);
		const snapshot = Schema.decodeUnknownSync(ReviewSnapshot)({
			...boot.snapshot,
			mergeBaseSha,
		});
		const assignReader = async (path: string): Promise<void> => {
			await chown(path, 1001, 1001);
			for (const entry of await readdir(path, { withFileTypes: true })) {
				const child = join(path, entry.name);
				if (entry.isDirectory()) await assignReader(child);
				else await chown(child, 1001, 1001);
			}
		};
		await chmod(repoRoot, 0o700);
		await assignReader(repoRoot);
		reader = await openReviewReader({
			root: repoRoot,
			snapshot,
			executable: input.workerExecutable,
			signal: controller.signal,
			uid: 1001,
		});
		const source = reader.source;
		await pulse();
		controller.signal.throwIfAborted();
		const artifact = await runReviewWithAdapter(
			{
				binding: {
					runId: boot.runId,
					connectionId: boot.connectionId,
					providerId: boot.agentProvider,
					model: boot.model,
					snapshot,
				},
				source,
				signal: controller.signal,
			},
			createNativeReviewFactory(
				{
					authHome: boot.authHome,
					trustedCwd,
					executablePath: input.executablePath,
					model: boot.model,
					nativeUid: 1000,
				},
				pulse,
				(code) => {
					errorCode = code;
				},
			),
		);
		result = Schema.decodeUnknownSync(ReviewResult)(artifact.result);
		if (errorCode) result = { ...result, status: "partial", reason: errorCode };
	} catch {
		errorCode ??= controller.signal.aborted
			? "cancelled-or-lease-lost"
			: "native-review-failed";
	} finally {
		clearInterval(timer);
		clearTimeout(deadlineTimer);
		controller.abort();
		await reader?.close();
		await heartbeat;
		input.signal.removeEventListener("abort", abort);
		// Only the adapter's completed shutdown permits a reusable auth sandbox.
		// Failures may include shutdown uncertainty: infrastructure destroys instead of pauses.
		if (runRoot && result) {
			await rm(runRoot, { recursive: true, force: true });
			cleanupConfirmed = true;
		}
		if (lockHeld && cleanupConfirmed)
			await rm(join(input.workRoot, "active"), { recursive: true });
	}
	await post(
		"result",
		result
			? { result, cleanupConfirmed, ...(errorCode ? { errorCode } : {}) }
			: { errorCode, cleanupConfirmed },
	);
}
