// Thin typed client over the Zuse Cloud Workspaces public API (`/v1/api/**`).
// Auth is the account-scoped API key (`Authorization: Bearer zk_…`); retries
// are safe because create/send accept an `Idempotency-Key` header.

export interface ZuseClientConfig {
	readonly apiUrl: string;
	readonly apiKey: string;
}

export interface ZuseWorkspace {
	readonly workspaceId: string;
	readonly branch: string;
	readonly state: string;
	readonly startupPhase: string;
	readonly agentStatus: "working" | "idle" | "unknown";
	readonly latestSeq: number;
}

const request = async <T>(
	config: ZuseClientConfig,
	path: string,
	init?: {
		readonly method?: "POST" | "DELETE";
		readonly body?: unknown;
		readonly idempotencyKey?: string;
	},
): Promise<T> => {
	const response = await fetch(`${config.apiUrl}${path}`, {
		method: init?.method ?? (init?.body === undefined ? "GET" : "POST"),
		headers: {
			authorization: `Bearer ${config.apiKey}`,
			...(init?.body === undefined
				? {}
				: { "content-type": "application/json" }),
			...(init?.idempotencyKey === undefined
				? {}
				: { "idempotency-key": init.idempotencyKey }),
		},
		body: init?.body === undefined ? undefined : JSON.stringify(init.body),
	});
	if (!response.ok)
		throw new Error(`zuse_api_${response.status}: ${await response.text()}`);
	return (await response.json()) as T;
};

export const createWorkspace = (
	config: ZuseClientConfig,
	input: { readonly prompt: string; readonly idempotencyKey: string },
): Promise<{ readonly workspace: ZuseWorkspace }> =>
	request(config, "/v1/api/workspaces", {
		body: { prompt: input.prompt },
		idempotencyKey: input.idempotencyKey,
	});

export const sendMessage = (
	config: ZuseClientConfig,
	input: {
		readonly workspaceId: string;
		readonly text: string;
		readonly idempotencyKey: string;
	},
): Promise<{ readonly messageId: string; readonly status: string }> =>
	request(
		config,
		`/v1/api/workspaces/${encodeURIComponent(input.workspaceId)}/messages`,
		{
			body: { text: input.text },
			idempotencyKey: input.idempotencyKey,
		},
	);

export const getWorkspace = (
	config: ZuseClientConfig,
	workspaceId: string,
): Promise<{ readonly workspace: ZuseWorkspace }> =>
	request(config, `/v1/api/workspaces/${encodeURIComponent(workspaceId)}`);
