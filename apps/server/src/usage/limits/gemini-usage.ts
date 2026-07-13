import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ProviderUsageLimits, UsageLimitWindow } from "@zuse/contracts";

import { decodeJwtPayload } from "../../provider/jwt.ts";
import { unavailable } from "./shared.ts";

type Bucket = {
	remainingFraction?: number;
	resetTime?: string;
	modelId?: string;
};

type AssistResponse = {
	cloudaicompanionProject?: string | { id?: string };
	paidTier?: { name?: string };
	currentTier?: { id?: string };
};

export const projectFromResourceList = (payload: {
	projects?: ReadonlyArray<{
		projectId?: string;
		labels?: Record<string, string>;
	}>;
}): string | null =>
	payload.projects?.find(
		(project) =>
			project.projectId?.startsWith("gen-lang-client") ||
			project.labels?.["generative-language"] !== undefined,
	)?.projectId ?? null;

const assistProject = (assist: AssistResponse): string | null =>
	typeof assist.cloudaicompanionProject === "string"
		? assist.cloudaicompanionProject
		: (assist.cloudaicompanionProject?.id ?? null);

export const geminiPlanLabel = (
	assist: AssistResponse,
	idToken?: string,
): string | null => {
	if (assist.paidTier?.name) return assist.paidTier.name;
	const tier = assist.currentTier?.id?.toLowerCase();
	if (!tier) return null;
	if (tier.includes("standard")) return "Paid";
	if (tier.includes("legacy")) return "Legacy";
	if (!tier.includes("free")) return "Paid";
	const hostedDomain = idToken ? decodeJwtPayload(idToken)?.hd : undefined;
	return typeof hostedDomain === "string" && hostedDomain.length > 0
		? "Workspace"
		: "Free";
};

const family = (model: string): string =>
	model.toLowerCase().includes("flash-lite")
		? "Flash-Lite"
		: model.toLowerCase().includes("flash")
			? "Flash"
			: "Pro";

export const mapGeminiQuota = (
	payload: { buckets?: Bucket[] },
	planLabel: string | null,
	fetchedAt = new Date().toISOString(),
): ProviderUsageLimits => {
	const grouped = new Map<string, Bucket>();
	for (const bucket of payload.buckets ?? []) {
		const name = family(bucket.modelId ?? "pro");
		const previous = grouped.get(name);
		if (
			!previous ||
			(bucket.remainingFraction ?? 1) < (previous.remainingFraction ?? 1)
		)
			grouped.set(name, bucket);
	}
	const windows: UsageLimitWindow[] = [...grouped].map(([name, bucket]) => ({
		id: `daily:${name.toLowerCase()}`,
		label: `Daily (${name})`,
		scope: "model",
		usedPercent: Math.min(
			100,
			Math.max(0, 100 - (bucket.remainingFraction ?? 1) * 100),
		),
		resetsAt: bucket.resetTime ?? null,
		windowMinutes: 1_440,
	}));
	return {
		providerId: "gemini",
		planLabel,
		windows,
		creditsRemaining: null,
		fetchedAt,
		source: "api",
	};
};

export const fetchGeminiUsage = async (): Promise<ProviderUsageLimits> => {
	try {
		const root = join(homedir(), ".gemini");
		const settings = JSON.parse(
			await readFile(join(root, "settings.json"), "utf8"),
		) as { selectedAuthType?: string };
		if (
			!String(settings.selectedAuthType ?? "")
				.toLowerCase()
				.includes("oauth")
		)
			return unavailable("gemini", "unsupported");
		const creds = JSON.parse(
			await readFile(join(root, "oauth_creds.json"), "utf8"),
		) as { access_token?: string; expiry_date?: number; id_token?: string };
		if (!creds.access_token) return unavailable("gemini", "no-credentials");
		if (creds.expiry_date && creds.expiry_date < Date.now())
			return unavailable("gemini", "expired");
		const headers = {
			Authorization: `Bearer ${creds.access_token}`,
			"Content-Type": "application/json",
		};
		const load = await fetch(
			"https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					metadata: { ideType: "GEMINI_CLI", pluginType: "GEMINI" },
				}),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!load.ok)
			return unavailable(
				"gemini",
				load.status === 401 ? "expired" : "unsupported",
			);
		const assist = (await load.json()) as AssistResponse;
		let project = assistProject(assist);
		if (!project) {
			const resources = await fetch(
				"https://cloudresourcemanager.googleapis.com/v1/projects",
				{
					headers: { Authorization: `Bearer ${creds.access_token}` },
					signal: AbortSignal.timeout(5_000),
				},
			);
			if (resources.status === 401) return unavailable("gemini", "expired");
			if (resources.ok) {
				project = projectFromResourceList(
					(await resources.json()) as {
						projects?: Array<{
							projectId?: string;
							labels?: Record<string, string>;
						}>;
					},
				);
			}
		}
		if (!project) return unavailable("gemini", "unsupported");
		const quota = await fetch(
			"https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
			{
				method: "POST",
				headers,
				body: JSON.stringify({ project }),
				signal: AbortSignal.timeout(5_000),
			},
		);
		if (!quota.ok)
			return unavailable(
				"gemini",
				quota.status === 401 ? "expired" : "unsupported",
			);
		return mapGeminiQuota(
			(await quota.json()) as { buckets?: Bucket[] },
			geminiPlanLabel(assist, creds.id_token),
		);
	} catch {
		return unavailable("gemini", "error");
	}
};
