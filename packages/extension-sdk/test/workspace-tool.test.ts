import { Schema } from "effect";
import { expect, it } from "vitest";
import type {
	ExtensionInvocationContext,
	ExtensionServerContext,
} from "../src/contracts.ts";
import { registerWorkspaceTool } from "../src/server.ts";
import { workspaceToolRpc } from "../src/workspace-tool.ts";

function harness(
	signal: AbortSignal,
	scan: (
		text: string,
		path: string,
	) => readonly { id: string; title: string; text: string }[],
) {
	let invoke: (input: unknown, context: ExtensionInvocationContext) => unknown =
		() => {
			throw new Error("Missing handler");
		};
	const server: ExtensionServerContext = {
		target: "server",
		handle(contract, handler) {
			if (contract.name === workspaceToolRpc.name)
				invoke = (input, context) =>
					handler(Schema.decodeUnknownSync(contract.input)(input), context);
		},
		addProvider() {},
		emitProviderEvent() {},
		storage: {
			get: async () => undefined,
			set: async () => {},
			delete: async () => {},
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
	registerWorkspaceTool(server, { scan });
	return async () =>
		Schema.decodeUnknownSync(workspaceToolRpc.output)(
			await invoke(
				{ action: "scan", path: "", query: "", cursor: 0 },
				{
					signal,
					workspace: {
						projectId: "project",
						workspacePath: "/repo",
						sessionId: null,
					},
					files: {
						list: async () => ({
							paths: ["bad.ts", "good.ts"],
							truncated: false,
						}),
						read: async () => "// TODO: fix",
					},
				},
			),
		);
}
it("continues after a per-file scanner failure and reports skipped files", async () => {
	const run = harness(new AbortController().signal, (text, path) => {
		if (path === "bad.ts") throw new Error("cannot parse");
		return [{ id: path, title: path, text }];
	});
	const result = await run();
	expect(result.items.map((item) => item.id)).toEqual(["good.ts"]);
	expect(result.status).toContain("1 files could not be inspected");
});
it("propagates cancellation instead of treating it as an unreadable file", async () => {
	const controller = new AbortController();
	const run = harness(controller.signal, () => {
		controller.abort(new Error("cancelled"));
		throw new Error("scan interrupted");
	});
	await expect(run()).rejects.toThrow("cancelled");
});
