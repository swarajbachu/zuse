// Thin typed client over the Zuse Cloud Workspaces public API (`/v1/api/**`).
// Auth is the account-scoped API key (`Authorization: Bearer zk_…`); retries
// are safe because create/send accept an `Idempotency-Key` header.

export interface ZuseClientConfig {
	readonly apiUrl: string;
	readonly apiKey: string;
	readonly requestTimeoutMs?: number;
	readonly workspaceDefaults?: {
		readonly agent?: string;
		readonly model?: string;
		readonly projectId?: string;
	};
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 1_000;

export class ZuseApiError extends Error {
	readonly status: number;

	constructor(status: number, detail: string) {
		super(`zuse_api_${status}: ${detail}`);
		this.name = "ZuseApiError";
		this.status = status;
	}

	get retryable(): boolean {
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

export const normalizeZuseApiUrl = (value: string): string => {
	const url = new URL(value.trim());
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new Error("zuse_api_url_invalid_protocol");
	url.hash = "";
	url.search = "";
	url.pathname = url.pathname.replace(/\/+$/u, "");
	return url.toString().replace(/\/$/u, "");
};

export interface ZuseWorkspace {
	readonly workspaceId: string;
	readonly branch: string;
	readonly state: string;
	readonly startupPhase: string;
	readonly agentStatus: "working" | "idle" | "unknown";
	readonly latestSeq: number;
}

export interface ZuseAsset {
	readonly assetId: string;
	readonly mimeType: string;
	readonly originalName: string;
	readonly sizeBytes: number;
}

const request = async <T>(
	config: ZuseClientConfig,
	path: string,
	init: {
		readonly body: BodyInit;
		readonly headers?: Readonly<Record<string, string>>;
		readonly idempotencyKey: string;
	},
): Promise<T> => {
	const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
		throw new Error("zuse_api_timeout_invalid");
	const response = await fetch(`${normalizeZuseApiUrl(config.apiUrl)}${path}`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${config.apiKey}`,
			"content-type": "application/json",
			"idempotency-key": init.idempotencyKey,
			...init.headers,
		},
		body: init.body,
		signal: AbortSignal.timeout(timeoutMs),
	});
	const rawBody = await response.text();
	if (!response.ok)
		throw new ZuseApiError(
			response.status,
			rawBody.slice(0, MAX_ERROR_BODY_LENGTH),
		);
	try {
		return JSON.parse(rawBody) as T;
	} catch {
		throw new Error(`zuse_api_invalid_response:${response.status}`);
	}
};

export const createWorkspace = (
	config: ZuseClientConfig,
	input: { readonly prompt?: string; readonly idempotencyKey: string },
): Promise<{ readonly workspace: ZuseWorkspace }> =>
	request(config, "/v1/api/workspaces", {
		body: JSON.stringify({
			...config.workspaceDefaults,
			...(input.prompt === undefined ? {} : { prompt: input.prompt }),
		}),
		idempotencyKey: input.idempotencyKey,
	});

export const sendMessage = (
	config: ZuseClientConfig,
	input: {
		readonly workspaceId: string;
		readonly text: string;
		readonly attachments?: ReadonlyArray<string>;
		readonly idempotencyKey: string;
	},
): Promise<{ readonly messageId: string; readonly status: string }> =>
	request(
		config,
		`/v1/api/workspaces/${encodeURIComponent(input.workspaceId)}/messages`,
		{
			body: JSON.stringify({
				text: input.text,
				...(input.attachments === undefined
					? {}
					: { attachments: input.attachments }),
			}),
			idempotencyKey: input.idempotencyKey,
		},
	);

export const uploadAsset = async (
	config: ZuseClientConfig,
	input: {
		readonly workspaceId: string;
		readonly bytes: Uint8Array;
		readonly mimeType: string;
		readonly originalName: string;
		readonly idempotencyKey: string;
	},
): Promise<ZuseAsset> => {
	const { asset } = await request<{ readonly asset: ZuseAsset }>(
		config,
		`/v1/api/workspaces/${encodeURIComponent(input.workspaceId)}/attachments`,
		{
			headers: {
				"content-type": input.mimeType,
				"x-zuse-file-name": input.originalName,
			},
			body: new Uint8Array(input.bytes).buffer,
			idempotencyKey: input.idempotencyKey,
		},
	);
	return asset;
};
