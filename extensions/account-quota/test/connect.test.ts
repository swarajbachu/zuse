import type {
	ExtensionInvocationContext,
	ExtensionServerContext,
} from "@zuse/extension-sdk";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { quotaRpc } from "../contracts.ts";
import { readAccountCredential } from "../credentials.ts";
import setup from "../index.server.ts";

vi.mock("../credentials.ts", () => ({
	readCredential: vi.fn(),
	readAccountCredential: vi.fn(async () => ({
		tokens: { access_token: "private-token", account_id: "work" },
	})),
}));
afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});
function harness() {
	const values = new Map<string, unknown>();
	let handle: (
		input: unknown,
		context: ExtensionInvocationContext,
	) => Promise<unknown> = async () => {
		throw new Error("No handler");
	};
	const context: ExtensionServerContext = {
		target: "server",
		handle(contract, handler) {
			handle = async (input, ctx) =>
				handler(Schema.decodeUnknownSync(contract.input)(input), ctx);
		},
		addProvider: () => {},
		addAcpProvider: () => () => {},
		emitProviderEvent: () => {},
		storage: {
			get: async (key) => values.get(key),
			set: async (key, value) => {
				values.set(key, value);
			},
			delete: async (key) => {
				values.delete(key);
			},
			version: async () => 0,
			migrate: async () => {},
		},
		blobs: {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
		},
		secrets: {
			get: async () => null,
			set: async () => {},
			delete: async () => {},
		},
		credentials: { get: async () => null },
	};
	const stop = setup(context);
	const invoke = async (
		action: "connect" | "list" | "remove",
		id = "",
		signal = new AbortController().signal,
	) =>
		Schema.decodeUnknownSync(quotaRpc.output)(
			await handle(
				{ action, id, label: "", provider: "codex", credentialPath: "" },
				{
					workspace: null,
					signal,
					files: {
						list: async () => ({ paths: [], truncated: false }),
						read: async () => "",
					},
				},
			),
		);
	return { values, invoke, stop };
}
it("connects and fetches in one action, saves no tokens, and never fetches on list", async () => {
	const request = vi.fn(
		async () =>
			new Response('{"rate_limit":{"primary_window":{"used_percent":24}}}'),
	);
	vi.stubGlobal("fetch", request);
	const h = harness();
	try {
		expect(await h.invoke("list")).toEqual([]);
		expect(readAccountCredential).not.toHaveBeenCalled();
		const rows = await h.invoke("connect");
		expect(rows[0]?.windows[0]?.usedPercent).toBe(24);
		expect(rows[0]?.account.usesCurrentLogin).toBe(true);
		expect(JSON.stringify(rows)).not.toContain("private-token");
		expect(JSON.stringify([...h.values])).not.toContain("private-token");
		expect(await h.invoke("connect")).toHaveLength(1);
		await h.invoke("list");
		expect(request).toHaveBeenCalledTimes(1);
		expect(readAccountCredential).toHaveBeenCalledTimes(1);
		expect(await h.invoke("remove", rows[0]?.account.id)).toHaveLength(0);
	} finally {
		h.stop();
	}
});
it("keeps a connected card with an actionable error when the provider rejects quota", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("private response", { status: 401 })),
	);
	const h = harness();
	try {
		const rows = await h.invoke("connect");
		expect(rows[0]?.error).toContain("expired");
		expect(JSON.stringify(rows)).not.toContain("private response");
	} finally {
		h.stop();
	}
});

it("cancels an in-flight connection and lets the next list reconcile its saved account", async () => {
	const request = vi.fn<typeof fetch>(
		async (_url, options) =>
			new Promise<Response>((_resolve, reject) => {
				options?.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			}),
	);
	vi.stubGlobal("fetch", request);
	const h = harness();
	const controller = new AbortController();
	try {
		const pending = h.invoke("connect", "", controller.signal);
		const rejected = expect(pending).rejects.toThrow();
		await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
		controller.abort();
		await rejected;
		const rows = await h.invoke("list");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.fetchedAt).toBeNull();
		expect(readAccountCredential).toHaveBeenCalledTimes(1);
		request.mockImplementation(
			async () =>
				new Response('{"rate_limit":{"primary_window":{"used_percent":24}}}'),
		);
		const refreshed = await h.invoke("connect");
		expect(request).toHaveBeenCalledTimes(2);
		expect(refreshed[0]?.windows[0]?.usedPercent).toBe(24);
	} finally {
		h.stop();
	}
});
