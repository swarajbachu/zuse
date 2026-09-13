// Account-scoped operations injected by the API. No loopback HTTP or API keys.

export interface ZuseClientConfig {
	readonly request: (path: string, init: RequestInit) => Promise<Response>;
	readonly requestTimeoutMs?: number;
	readonly workspaceDefaults?: {
		readonly agent?: string;
		readonly model?: string;
		readonly projectId?: string;
	};
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_BODY_LENGTH = 1_000;

export type ZuseOperation =
	| "workspace_create"
	| "workspace_read"
	| "projects_list"
	| "message_send"
	| "messages_read"
	| "attachment_upload"
	| "webhook_create"
	| "webhook_delete"
	| "unknown";
const operationFor = (path: string, method: string): ZuseOperation => {
	if (path === "/v1/api/workspaces" && method === "POST")
		return "workspace_create";
	if (path === "/v1/api/projects") return "projects_list";
	if (/^\/v1\/api\/workspaces\/[^/?]+$/u.test(path)) return "workspace_read";
	if (/\/messages(?:\?|$)/u.test(path))
		return method === "GET" ? "messages_read" : "message_send";
	if (path.endsWith("/attachments")) return "attachment_upload";
	if (path === "/v1/api/webhooks") return "webhook_create";
	if (path.startsWith("/v1/api/webhooks/")) return "webhook_delete";
	return "unknown";
};

export const diagnosticCode = (value: unknown): string | undefined =>
	typeof value === "string" &&
	/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/u.test(value) &&
	value.length <= 80 &&
	!/^(?:zk|sk|ghp|gho|xoxb|xoxp|token|secret|password)_/u.test(value)
		? value
		: undefined;

export class ZuseApiError extends Error {
	readonly status: number;
	readonly code?: string;

	constructor(
		status: number,
		detail: string,
		readonly operation: ZuseOperation = "unknown",
	) {
		super(`zuse_api_${status}: ${detail}`);
		this.name = "ZuseApiError";
		this.status = status;
		try {
			const body: unknown = JSON.parse(detail);
			if (body && typeof body === "object") {
				this.code = diagnosticCode(
					"code" in body ? body.code : "error" in body ? body.error : undefined,
				);
			}
		} catch {
			/* Never log raw response bodies. */
		}
	}

	get retryable(): boolean {
		return this.status === 408 || this.status === 429 || this.status >= 500;
	}
}

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
		readonly body?: BodyInit;
		readonly method?: "GET" | "POST" | "DELETE";
		readonly headers?: Readonly<Record<string, string>>;
		readonly idempotencyKey?: string;
	},
): Promise<T> => {
	const timeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
		throw new Error("zuse_api_timeout_invalid");
	const response = await config.request(path, {
		method: init.method ?? "POST",
		headers: {
			"content-type": "application/json",
			...(init.idempotencyKey
				? { "idempotency-key": init.idempotencyKey }
				: {}),
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
			operationFor(path, init.method ?? "POST"),
		);
	try {
		return JSON.parse(rawBody) as T;
	} catch {
		throw new Error(`zuse_api_invalid_response:${response.status}`);
	}
};

export interface ZuseProject {
	readonly projectId: string;
	readonly displayName: string;
	readonly state: string;
}
export const getWorkspace = (
	config: ZuseClientConfig,
	workspaceId: string,
): Promise<{ workspace: ZuseWorkspace }> =>
	request(config, `/v1/api/workspaces/${encodeURIComponent(workspaceId)}`, {
		method: "GET",
	});
export const listProjects = (
	config: ZuseClientConfig,
): Promise<{ projects: ZuseProject[] }> =>
	request(config, "/v1/api/projects", { method: "GET" });
export const readTurn = async (
	config: ZuseClientConfig,
	workspaceId: string,
	messageId: string,
	afterSeq: number,
) => {
	const { messages } = await request<{
		messages: {
			messageId: string;
			turnId?: string;
			role: string;
			text: string;
			outcome?: string;
			status?: string;
		}[];
	}>(
		config,
		`/v1/api/workspaces/${encodeURIComponent(workspaceId)}/messages?afterSeq=${afterSeq}&limit=100`,
		{ method: "GET" },
	);
	const submitted = messages.find(
		(message) => message.messageId === messageId && message.role === "user",
	);
	const turnId = submitted?.turnId;
	const result = turnId
		? messages.find(
				(message) =>
					message.turnId === turnId &&
					message.role === "assistant" &&
					message.outcome,
			)
		: undefined;
	return { turnId, result, requestStatus: submitted?.status };
};
export const registerWebhook = (
	config: ZuseClientConfig,
	url: string,
): Promise<{ webhook: { webhookId: string }; secret: string }> =>
	request(config, "/v1/api/webhooks", {
		body: JSON.stringify({ url, description: "Zuse Slack app" }),
	});
export const deleteWebhook = async (
	config: ZuseClientConfig,
	webhookId: string,
): Promise<void> => {
	try {
		await request(config, `/v1/api/webhooks/${encodeURIComponent(webhookId)}`, {
			method: "DELETE",
		});
	} catch (error) {
		if (!(error instanceof ZuseApiError && error.status === 404)) throw error;
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
): Promise<{
	readonly messageId: string;
	readonly status: string;
	readonly seq: number;
}> =>
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
