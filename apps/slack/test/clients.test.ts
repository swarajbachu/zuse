import { afterEach, describe, expect, it, vi } from "vitest";
import { parseSlackFiles, postSlackMessage } from "../src/slack.ts";
import {
	createWorkspace,
	uploadAsset,
	ZuseApiError,
	type ZuseClientConfig,
} from "../src/zuse.ts";

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
				{ request: (path, init) => fetch(path, init) },
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
			"/v1/api/workspaces/workspace_1/attachments",
			expect.objectContaining({
				method: "POST",
				body: new Uint8Array([1, 2]).buffer,
				headers: {
					"content-type": "image/png",
					"x-zuse-file-name": "bug.png",
					"idempotency-key": "upload-1",
				},
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("calls the injected operation with a timeout signal", async () => {
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
				request: (path, init) => fetch(path, init),
				requestTimeoutMs: 250,
			},
			{ prompt: "test", idempotencyKey: "request-1" },
		);

		expect(requestedUrl).toBe("/v1/api/workspaces");
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
	const config: ZuseClientConfig = {
		request: (path, init) => fetch(path, init),
	};
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
