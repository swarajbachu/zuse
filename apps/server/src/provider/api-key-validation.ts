import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	Agent,
	AuthenticationError,
	Cursor,
	CursorSdkError,
	JsonlLocalAgentStore,
	type Run,
	type SDKAgent,
} from "@cursor/sdk";
import { Effect } from "effect";

export type ApiKeyValidationResult =
	| { readonly status: "verified" }
	| { readonly status: "invalid"; readonly reason: string }
	| { readonly status: "unverified"; readonly warning: string };

const DEFAULT_INVALID_REASON =
	"The API key was rejected. Check the key and try again.";
const DEFAULT_UNVERIFIED_WARNING =
	"The API key was saved, but it could not be verified. Check your connection and recheck the provider when online.";
const PROBE_RESPONSE = "ZUSE_READY";
const PROBE_TIMEOUT_MS = 20_000;

const messageOf = (cause: unknown): string =>
	cause instanceof Error ? cause.message : String(cause);

const isAuthenticationCode = (code: string | undefined): boolean =>
	typeof code === "string" &&
	/(?:^|_)(?:auth(?:entication)?|unauthori[sz]ed|invalid_api_key|bad_(?:user_)?api_key)(?:_|$)|^401$/i.test(
		code,
	);

/** Classify SDK failures without treating connectivity or service faults as bad keys. */
export const classifyApiKeyValidationError = (
	cause: unknown,
): ApiKeyValidationResult => {
	const message = messageOf(cause);
	const explicitAuthenticationFailure =
		cause instanceof AuthenticationError ||
		(cause instanceof CursorSdkError && cause.status === 401) ||
		/(?:invalid|expired|revoked).*api key|api key.*(?:invalid|expired|revoked)|unauthori[sz]ed|\b401\b/i.test(
			message,
		);
	return explicitAuthenticationFailure
		? { status: "invalid", reason: DEFAULT_INVALID_REASON }
		: { status: "unverified", warning: DEFAULT_UNVERIFIED_WARNING };
};

const runMessageProbe = async (apiKey: string): Promise<void> => {
	const resources: { agent: SDKAgent | null; run: Run | null } = {
		agent: null,
		run: null,
	};
	let probeDirectory: string | null = null;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let timedOut = false;

	const cleanup = async (): Promise<void> => {
		const run = resources.run;
		resources.run = null;
		if (run?.status === "running") {
			void run.cancel().catch(() => undefined);
		}

		const agent = resources.agent;
		resources.agent = null;
		try {
			agent?.close();
		} catch {
			// Cleanup must not change the validation classification.
		}

		const directory = probeDirectory;
		probeDirectory = null;
		if (directory !== null) {
			await rm(directory, { recursive: true, force: true }).catch(
				() => undefined,
			);
		}
	};

	const ensureWithinDeadline = (): void => {
		if (timedOut) throw new Error("The SDK message probe timed out.");
	};

	const probe = async () => {
		const models = await Cursor.models.list({ apiKey });
		ensureWithinDeadline();
		const selected =
			models.find((model) => model.id === "composer-2") ?? models[0];
		if (selected === undefined) {
			throw new Error("The SDK returned no available models.");
		}

		const model = { id: selected.id };
		probeDirectory = await mkdtemp(join(tmpdir(), "zuse-sdk-probe-"));
		ensureWithinDeadline();
		resources.agent = await Agent.create({
			apiKey,
			model,
			mode: "plan",
			name: "Zuse readiness check",
			local: {
				cwd: tmpdir(),
				store: new JsonlLocalAgentStore(probeDirectory),
				autoReview: true,
				sandboxOptions: { enabled: true },
				settingSources: [],
				enableAgentRetries: false,
			},
		});
		ensureWithinDeadline();
		resources.run = await resources.agent.send(
			`Reply with exactly ${PROBE_RESPONSE}. Do not use tools.`,
			{ model, mode: "plan" },
		);
		ensureWithinDeadline();

		let response = "";
		for await (const message of resources.run.stream()) {
			if (message.type !== "assistant") continue;
			for (const block of message.message.content) {
				if (block.type === "text") response += block.text;
			}
		}
		const result = await resources.run.wait();
		if (result.status !== "finished") {
			if (isAuthenticationCode(result.error?.code)) {
				throw new AuthenticationError(
					result.error?.message ?? "The API key was rejected.",
				);
			}
			throw new Error(result.error?.message ?? "The SDK message probe failed.");
		}
		if (!response.includes(PROBE_RESPONSE)) {
			throw new Error("The SDK message probe returned an unexpected response.");
		}
	};

	const pendingProbe = probe().finally(cleanup);
	try {
		await Promise.race([
			pendingProbe,
			new Promise<never>((_, reject) => {
				timeout = setTimeout(() => {
					timedOut = true;
					reject(new Error("The SDK message probe timed out."));
				}, PROBE_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
		await cleanup();
	}
};

/**
 * Verify a candidate key through a real, bounded local SDK message. The
 * catalog request selects an available model, but readiness is only confirmed
 * after the agent runtime successfully streams the expected response.
 */
export const validateApiKey = (
	apiKey: string,
): Effect.Effect<ApiKeyValidationResult> =>
	Effect.tryPromise({
		try: () => runMessageProbe(apiKey),
		catch: (cause) => cause,
	}).pipe(
		Effect.as({ status: "verified" as const }),
		Effect.catch((cause) =>
			Effect.succeed(classifyApiKeyValidationError(cause)),
		),
	);
