import { spawn } from "node:child_process";
import type { KiroInventory, KiroInventoryModel } from "@zuse/contracts";
import { Effect } from "effect";

import {
	type KiroAuthContext,
	kiroControlPlaneRequest,
	readKiroAuthContext,
} from "./kiro-auth.ts";

/**
 * Live Kiro model inventory. Prefer the control-plane
 * `ListAvailableModels` API (richer: context windows, credit multipliers,
 * image support). Fall back to `kiro-cli chat --list-models --format json`
 * when the API is unreachable so the picker still refreshes.
 */

interface ListModelsApiModel {
	readonly modelId?: string;
	readonly modelName?: string;
	readonly description?: string;
	readonly rateMultiplier?: number;
	readonly rateUnit?: string;
	readonly supportedInputTypes?: ReadonlyArray<string>;
	readonly tokenLimits?: {
		readonly maxInputTokens?: number;
		readonly maxOutputTokens?: number;
	};
}

interface ListModelsApiResponse {
	readonly models?: ReadonlyArray<ListModelsApiModel>;
	readonly defaultModel?: { readonly modelId?: string };
}

interface CliListModelsResponse {
	readonly models?: ReadonlyArray<{
		readonly model_id?: string;
		readonly model_name?: string;
		readonly description?: string;
		readonly context_window_tokens?: number;
		readonly rate_multiplier?: number;
		readonly rate_unit?: string;
	}>;
	readonly default_model?: string;
}

const humanizeModelId = (id: string): string => {
	// claude-opus-4.8 → Claude Opus 4.8; gpt-5.6-sol → Gpt 5.6 Sol
	return id
		.split(/[-_]/)
		.map((part) => {
			if (part.length === 0) return part;
			if (/^\d/.test(part)) return part;
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join(" ");
};

const fromApiModel = (model: ListModelsApiModel): KiroInventoryModel | null => {
	const id = model.modelId?.trim();
	if (id === undefined || id.length === 0) return null;
	const label =
		typeof model.modelName === "string" && model.modelName.length > 0
			? humanizeModelId(model.modelName)
			: humanizeModelId(id);
	const supportsImages = (model.supportedInputTypes ?? []).some(
		(t) => t.toUpperCase() === "IMAGE",
	);
	const contextWindow =
		typeof model.tokenLimits?.maxInputTokens === "number"
			? model.tokenLimits.maxInputTokens
			: null;
	const rateMultiplier =
		typeof model.rateMultiplier === "number" ? model.rateMultiplier : null;
	return {
		id,
		label,
		description:
			typeof model.description === "string" ? model.description : null,
		contextWindow,
		rateMultiplier,
		supportsImages,
	};
};

const fromCliModel = (
	model: NonNullable<CliListModelsResponse["models"]>[number],
): KiroInventoryModel | null => {
	const id = model.model_id?.trim();
	if (id === undefined || id.length === 0) return null;
	return {
		id,
		label: humanizeModelId(
			typeof model.model_name === "string" && model.model_name.length > 0
				? model.model_name
				: id,
		),
		description:
			typeof model.description === "string" ? model.description : null,
		contextWindow:
			typeof model.context_window_tokens === "number"
				? model.context_window_tokens
				: null,
		rateMultiplier:
			typeof model.rate_multiplier === "number" ? model.rate_multiplier : null,
		// CLI list does not advertise input types; assume image support for
		// the majority of Kiro models (API path is authoritative when available).
		supportsImages: true,
	};
};

const listViaApi = async (
	auth: KiroAuthContext,
): Promise<KiroInventory | null> => {
	try {
		const result = await kiroControlPlaneRequest<ListModelsApiResponse>(
			auth,
			"ListAvailableModels",
			{
				origin: "KIRO_CLI",
				...(auth.profileArn === null ? {} : { profileArn: auth.profileArn }),
			},
		);
		const models = (result.models ?? [])
			.map(fromApiModel)
			.filter((m): m is KiroInventoryModel => m !== null);
		if (models.length === 0) return null;
		const defaultModelId =
			typeof result.defaultModel?.modelId === "string" &&
			result.defaultModel.modelId.length > 0
				? result.defaultModel.modelId
				: (models[0]?.id ?? "auto");
		return { models, defaultModelId };
	} catch {
		return null;
	}
};

const listViaCli = (kiroPath: string): Promise<KiroInventory | null> =>
	new Promise((resolve) => {
		const child = spawn(
			kiroPath,
			["chat", "--list-models", "--format", "json"],
			{
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let settled = false;
		const finish = (value: KiroInventory | null) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(null);
		}, 12_000);
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.on("error", () => {
			clearTimeout(timer);
			finish(null);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				finish(null);
				return;
			}
			try {
				const parsed = JSON.parse(stdout) as CliListModelsResponse;
				const models = (parsed.models ?? [])
					.map(fromCliModel)
					.filter((m): m is KiroInventoryModel => m !== null);
				if (models.length === 0) {
					finish(null);
					return;
				}
				const defaultModelId =
					typeof parsed.default_model === "string" &&
					parsed.default_model.length > 0
						? parsed.default_model
						: (models[0]?.id ?? "auto");
				finish({ models, defaultModelId });
			} catch {
				finish(null);
			}
		});
	});

export const loadKiroInventory = (
	kiroPath: string,
): Effect.Effect<KiroInventory, Error> =>
	Effect.tryPromise({
		try: async () => {
			const auth = readKiroAuthContext({ kiroPath });
			if (auth !== null) {
				const fromApi = await listViaApi(auth);
				if (fromApi !== null) return fromApi;
			}
			const fromCli = await listViaCli(kiroPath);
			if (fromCli !== null) return fromCli;
			throw new Error(
				"Could not load Kiro model inventory. Sign in with `kiro-cli login` and try again.",
			);
		},
		catch: (cause) =>
			cause instanceof Error
				? cause
				: new Error(`Kiro inventory failed: ${String(cause)}`),
	});
