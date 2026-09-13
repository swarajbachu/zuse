import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlackFiles, postSlackMessage } from "./slack.ts";
import worker, {
	type Env,
	type ExecutionContext,
	type KvNamespace,
} from "./worker.ts";
import {
	createWorkspace,
	normalizeZuseApiUrl,
	uploadAsset,
	ZuseApiError,
	type ZuseClientConfig,
} from "./zuse.ts";

const encoder = new TextEncoder();

const hmacSha256Hex = async (
	secret: string,
	message: string,
): Promise<string> => {
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(message),
	);
	return [...new Uint8Array(signature)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

class MemoryKv implements KvNamespace {
	readonly values = new Map<string, string>();

	get(key: string): Promise<string | null> {
		return Promise.resolve(this.values.get(key) ?? null);
	}

	put(key: string, value: string): Promise<void> {
		this.values.set(key, value);
		return Promise.resolve();
	}
}

class FailFirstDedupePutKv extends MemoryKv {
	private failed = false;

	override put(key: string, value: string): Promise<void> {
		if (key.startsWith("event:") && !this.failed) {
			this.failed = true;
			return Promise.reject(new Error("temporary KV failure"));
		}
		return super.put(key, value);
	}
}

const makeEnv = (kv: MemoryKv): Env => ({
	THREADS: kv,
	ZUSE_API_URL: "https://api.zuse.sh/",
	SLACK_SIGNING_SECRET: "slack-signing-secret",
	SLACK_BOT_TOKEN: "xoxb-test",
	SLACK_USER_TOKEN: "xoxp-test",
	ZUSE_API_KEY: "zk_test",
	ZUSE_WEBHOOK_SECRET: "whsec_test",
});

const context: ExecutionContext = {
	waitUntil: () => undefined,
};

const zuseWebhookRequest = async (
	body: string,
	secret = "whsec_test",
): Promise<Request> => {
	const timestamp = Math.floor(Date.now() / 1_000);
	const signature = await hmacSha256Hex(secret, `${timestamp}.${body}`);
	return new Request("https://bot.test/zuse/webhook", {
		method: "POST",
		headers: { "zuse-signature": `t=${timestamp},v1=${signature}` },
		body,
	});
};

const slackEventRequest = async (
	body: string,
	secret = "slack-signing-secret",
): Promise<Request> => {
	const timestamp = Math.floor(Date.now() / 1_000).toString();
	const signature = await hmacSha256Hex(secret, `v0:${timestamp}:${body}`);
	return new Request("https://bot.test/slack/events", {
		method: "POST",
		headers: {
			"x-slack-request-timestamp": timestamp,
			"x-slack-signature": `v0=${signature}`,
		},
		body,
	});
};

const slackInteractionRequest = async (payload: unknown): Promise<Request> => {
	const rawBody = new URLSearchParams({
		payload: JSON.stringify(payload),
	}).toString();
	const timestamp = Math.floor(Date.now() / 1_000).toString();
	const signature = await hmacSha256Hex(
		"slack-signing-secret",
		`v0:${timestamp}:${rawBody}`,
	);
	return new Request("https://bot.test/slack/interactions", {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			"x-slack-request-timestamp": timestamp,
			"x-slack-signature": `v0=${signature}`,
		},
		body: rawBody,
	});
};

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("Slack API reliability", () => {
	it("normalizes complete file metadata and skips incomplete entries", () => {
		expect(
			parseSlackFiles([
				{ id: "incomplete" },
				{
					id: "F1",
					name: "bug.png",
					mimetype: "image/png",
					size: 4,
					url_private_download: "https://files.slack.com/files-pri/F1",
				},
			]),
		).toEqual([
			{
				id: "F1",
				name: "bug.png",
				mimetype: "image/png",
				size: 4,
				urlPrivateDownload: "https://files.slack.com/files-pri/F1",
			},
		]);
		expect(parseSlackFiles()).toEqual([]);
		expect(parseSlackFiles(null)).toEqual([]);
		expect(parseSlackFiles(JSON.parse('[null, {}, "invalid"]'))).toEqual([]);
	});

	it("throws when Slack returns an application-level failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: false, error: "ratelimited" })),
		);

		await expect(
			postSlackMessage({
				botToken: "xoxb-test",
				channel: "C1",
				text: "hello",
			}),
		).rejects.toThrow("slack_api_ratelimited");
	});

	it("requires Slack to return the posted message timestamp", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true })),
		);

		await expect(
			postSlackMessage({
				botToken: "xoxb-test",
				channel: "C1",
				text: "hello",
			}),
		).rejects.toThrow("slack_api_missing_message_ts");
	});
});

describe("Zuse client reliability", () => {
	it("uploads only the selected byte view through the shared request handler", async () => {
		const asset = {
			assetId: "asset_1",
			mimeType: "image/png",
			originalName: "bug.png",
			sizeBytes: 2,
		};
		const fetchMock = vi.fn(async () => Response.json({ asset }));
		vi.stubGlobal("fetch", fetchMock);
		const backing = new Uint8Array([99, 1, 2, 99]);
		await expect(
			uploadAsset(
				{ apiUrl: "https://api.zuse.sh/", apiKey: "zk_test" },
				{
					workspaceId: "workspace_1",
					bytes: backing.subarray(1, 3),
					mimeType: "image/png",
					originalName: "bug.png",
					idempotencyKey: "upload-1",
				},
			),
		).resolves.toEqual(asset);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.zuse.sh/v1/api/workspaces/workspace_1/attachments",
			expect.objectContaining({
				method: "POST",
				body: new Uint8Array([1, 2]).buffer,
				headers: {
					authorization: "Bearer zk_test",
					"content-type": "image/png",
					"x-zuse-file-name": "bug.png",
					"idempotency-key": "upload-1",
				},
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("normalizes the API base URL and attaches a timeout signal", async () => {
		let requestedUrl = "";
		let signal: AbortSignal | null | undefined;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				requestedUrl = String(input);
				signal = init?.signal;
				return Response.json({ workspace: { workspaceId: "workspace_1" } });
			}),
		);

		await createWorkspace(
			{
				apiUrl: "  https://api.zuse.sh///?ignored=yes#fragment  ",
				apiKey: "zk_test",
				requestTimeoutMs: 250,
			},
			{ prompt: "test", idempotencyKey: "request-1" },
		);

		expect(normalizeZuseApiUrl("https://api.zuse.sh///")).toBe(
			"https://api.zuse.sh",
		);
		expect(requestedUrl).toBe("https://api.zuse.sh/v1/api/workspaces");
		expect(signal).toBeInstanceOf(AbortSignal);
	});
});

describe.each([
	{
		name: "workspace creation",
		call: (config: ZuseClientConfig) =>
			createWorkspace(config, { prompt: "test", idempotencyKey: "create-1" }),
	},
	{
		name: "asset upload",
		call: (config: ZuseClientConfig) =>
			uploadAsset(config, {
				workspaceId: "workspace_1",
				bytes: new Uint8Array([1]),
				mimeType: "image/png",
				originalName: "bug.png",
				idempotencyKey: "upload-1",
			}),
	},
])("shared request policy: $name", ({ call }) => {
	const config = { apiUrl: "https://api.zuse.sh", apiKey: "zk_test" };
	it.each([
		0,
		-1,
		1.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
	])("rejects invalid timeout %s before sending", async (requestTimeoutMs) => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(call({ ...config, requestTimeoutMs })).rejects.toThrow(
			"zuse_api_timeout_invalid",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("preserves retryable errors", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("unavailable", { status: 503 })),
		);
		await expect(call(config)).rejects.toMatchObject({
			name: "ZuseApiError",
			status: 503,
			retryable: true,
		});
		expect(new ZuseApiError(400, "invalid input").retryable).toBe(false);
	});
	it("reports malformed JSON consistently", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("not JSON")),
		);
		await expect(call(config)).rejects.toThrow("zuse_api_invalid_response:200");
	});
});

describe("Slack event acknowledgement", () => {
	it("downloads and uploads attachment batches one file at a time", async () => {
		const kv = new MemoryKv();
		kv.values.set("thread:C1:123.456", "workspace_1");
		let buffered = 0;
		let maxBuffered = 0;
		let uploaded = 0;
		const files = Array.from({ length: 8 }, (_, index) => ({
			id: `F${index}`,
			name: `${index}.png`,
			mimetype: "image/png",
			size: 4,
			url_private_download: `https://files.slack.com/files-pri/F${index}`,
		}));
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				if (url.startsWith("https://files.slack.com/")) {
					maxBuffered = Math.max(maxBuffered, ++buffered);
					return new Response(new Uint8Array([1, 2, 3, 4]));
				}
				if (url.endsWith("/attachments")) {
					buffered--;
					return Response.json({ asset: { assetId: `asset_${++uploaded}` } });
				}
				if (url.endsWith("/messages")) {
					expect(JSON.parse(String(init?.body)).attachments).toHaveLength(8);
					return Response.json({ messageId: "message_1", status: "queued" });
				}
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
		const response = await worker.fetch(
			await slackEventRequest(
				JSON.stringify({
					type: "event_callback",
					event_id: "files-event",
					event: {
						type: "message",
						channel: "C1",
						thread_ts: "123.456",
						files,
					},
				}),
			),
			makeEnv(kv),
			context,
		);
		expect(response.status).toBe(200);
		expect(uploaded).toBe(8);
		expect(buffered).toBe(0);
		expect(maxBuffered).toBe(1);
	});

	it("returns a retryable response when forwarding a follow-up fails transiently", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const kv = new MemoryKv();
		kv.values.set("thread:C1:123.456", "workspace_1");
		const send = vi.fn(async () => new Response("temporary", { status: 503 }));
		vi.stubGlobal("fetch", send);
		const body = JSON.stringify({
			type: "event_callback",
			event_id: "slack_evt_1",
			event: {
				type: "message",
				channel: "C1",
				thread_ts: "123.456",
				text: "please continue",
			},
		});

		const response = await worker.fetch(
			await slackEventRequest(body),
			makeEnv(kv),
			context,
		);

		expect(response.status).toBe(503);
		expect(send).toHaveBeenCalledWith(
			"https://api.zuse.sh/v1/api/workspaces/workspace_1/messages",
			expect.objectContaining({
				headers: expect.objectContaining({
					"idempotency-key": "slack-event:slack_evt_1",
				}),
			}),
		);
	});
});

describe("native Slack thread import", () => {
	it("hydrates the full thread, uploads its image, and sends one rich command", async () => {
		const kv = new MemoryKv();
		const calls: Array<{ readonly url: string; readonly init?: RequestInit }> =
			[];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push({ url, init });
				if (url.startsWith("https://slack.com/api/conversations.replies"))
					return Response.json({
						ok: true,
						messages: [
							{ ts: "1", user: "U1", text: "The screenshot is broken" },
							{
								ts: "2",
								user: "U2",
								text: "Please fix it",
								files: [
									{
										id: "F1",
										name: "bug.png",
										mimetype: "image/png",
										size: 4,
										url_private_download:
											"https://files.slack.com/files-pri/F1",
									},
								],
							},
						],
					});
				if (url === "https://api.zuse.sh/v1/api/workspaces")
					return Response.json({
						workspace: { workspaceId: "workspace_1", branch: "pikachu" },
					});
				if (url === "https://slack.com/api/chat.postMessage")
					return Response.json({ ok: true, ts: "3" });
				if (url === "https://files.slack.com/files-pri/F1")
					return new Response(new Uint8Array([1, 2, 3, 4]));
				if (
					url ===
					"https://api.zuse.sh/v1/api/workspaces/workspace_1/attachments"
				)
					return Response.json({
						asset: {
							assetId: "asset_1",
							mimeType: "image/png",
							originalName: "bug.png",
							sizeBytes: 4,
						},
					});
				if (
					url === "https://api.zuse.sh/v1/api/workspaces/workspace_1/messages"
				)
					return Response.json({ messageId: "msg_1", status: "queued" });
				throw new Error(`unexpected fetch: ${url}`);
			}),
		);
		const pending: Promise<unknown>[] = [];
		const response = await worker.fetch(
			await slackInteractionRequest({
				type: "message_action",
				callback_id: "open_in_zuse",
				trigger_id: "trigger-1",
				channel: { id: "C1" },
				message: { ts: "1" },
			}),
			makeEnv(kv),
			{ waitUntil: (promise) => pending.push(Promise.resolve(promise)) },
		);
		expect(response.status).toBe(200);
		await Promise.all(pending);

		const create = calls.find(
			(call) => call.url === "https://api.zuse.sh/v1/api/workspaces",
		);
		expect(JSON.parse(String(create?.init?.body))).toEqual({});
		const sent = calls.find((call) =>
			call.url.endsWith("/workspace_1/messages"),
		);
		expect(JSON.parse(String(sent?.init?.body))).toMatchObject({
			attachments: ["asset_1"],
			text: expect.stringContaining("The screenshot is broken"),
		});
		expect(String(sent?.init?.body)).toContain("Please fix it");
		expect(kv.values.get("thread:C1:1")).toBe("workspace_1");
	});
});

describe("Zuse webhook acknowledgement", () => {
	const event = JSON.stringify({
		eventId: "evt_1",
		type: "workspace.turn.completed",
		workspaceId: "workspace_1",
		messageId: "msg_turn_1",
		outcome: "completed",
		reply: { text: "done", truncated: false },
	});

	it("does not deduplicate or acknowledge a failed Slack post", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const kv = new MemoryKv();
		kv.values.set(
			"workspace:workspace_1",
			JSON.stringify({ channel: "C1", threadTs: "123.456" }),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: false, error: "internal_error" })),
		);

		const response = await worker.fetch(
			await zuseWebhookRequest(event),
			makeEnv(kv),
			context,
		);

		expect(response.status).toBe(502);
		expect(kv.values.has("event:evt_1")).toBe(false);
	});

	it("requests a retry while the Slack thread mapping is not visible", async () => {
		const kv = new MemoryKv();
		const post = vi.fn();
		vi.stubGlobal("fetch", post);

		const response = await worker.fetch(
			await zuseWebhookRequest(event),
			makeEnv(kv),
			context,
		);

		expect(response.status).toBe(503);
		expect(post).not.toHaveBeenCalled();
		expect(kv.values.has("event:evt_1")).toBe(false);
	});

	it("writes dedupe only after Slack accepts the post", async () => {
		const kv = new MemoryKv();
		kv.values.set(
			"workspace:workspace_1",
			JSON.stringify({ channel: "C1", threadTs: "123.456" }),
		);
		let postedInit: RequestInit | undefined;
		const post = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				postedInit = init;
				return Response.json({ ok: true, ts: "123.789" });
			},
		);
		vi.stubGlobal("fetch", post);

		const response = await worker.fetch(
			await zuseWebhookRequest(event),
			makeEnv(kv),
			context,
		);

		expect(response.status).toBe(200);
		expect(kv.values.get("event:evt_1")).toBe("1");
		expect(post).toHaveBeenCalledTimes(1);
		const body = JSON.parse(String(postedInit?.body)) as {
			readonly client_msg_id?: string;
		};
		expect(body.client_msg_id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
		);
	});

	it("reuses Slack's client message id after a post-success KV failure", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const kv = new FailFirstDedupePutKv();
		kv.values.set(
			"workspace:workspace_1",
			JSON.stringify({ channel: "C1", threadTs: "123.456" }),
		);
		const bodies: Array<{ readonly client_msg_id?: string }> = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number]);
				return Response.json({ ok: true, ts: "123.789" });
			}),
		);

		const first = await worker.fetch(
			await zuseWebhookRequest(event),
			makeEnv(kv),
			context,
		);
		const retry = await worker.fetch(
			await zuseWebhookRequest(event),
			makeEnv(kv),
			context,
		);

		expect(first.status).toBe(502);
		expect(retry.status).toBe(200);
		expect(bodies).toHaveLength(2);
		expect(bodies[0]?.client_msg_id).toBe(bodies[1]?.client_msg_id);
		expect(kv.values.get("event:evt_1")).toBe("1");
	});
});
