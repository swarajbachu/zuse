import { handleAcpNativePermissionRequest } from "@zuse/agents/drivers/acp/native-permission";
import type {
	PermissionDecision,
	PermissionKind,
	PermissionMode,
	RuntimeMode,
} from "@zuse/contracts";
import { describe, expect, it } from "vitest";

const makeCtx = (opts: {
	readonly runtimeMode: RuntimeMode;
	readonly permissionMode?: PermissionMode;
	readonly onRequest?: () => void;
}) => ({
	requestPermission: async (
		_kind: PermissionKind,
		_options: { readonly forcePrompt: boolean },
	): Promise<PermissionDecision> => {
		opts.onRequest?.();
		return { _tag: "AllowOnce" };
	},
	getRuntimeMode: () => opts.runtimeMode,
	getPermissionMode: () => opts.permissionMode ?? "default",
});

describe("ACP native permission classification", () => {
	it("prompts for read-sounding tool names in approval-required mode", async () => {
		// `list_users` carries a read token, but the tool may still mutate —
		// a name heuristic must not silently approve it.
		let requestCount = 0;
		const result = await handleAcpNativePermissionRequest(
			"session/request_permission",
			{
				tool: "list_users",
				options: [{ optionId: "yes-once", kind: "allow_once" }],
			},
			makeCtx({
				runtimeMode: "approval-required",
				onRequest: () => {
					requestCount += 1;
				},
			}),
		);
		expect(requestCount).toBe(1);
		expect(result).toMatchObject({ outcome: { outcome: "selected" } });
	});

	it("keeps the read-only fast path in plan mode", async () => {
		let requestCount = 0;
		const result = await handleAcpNativePermissionRequest(
			"session/request_permission",
			{
				tool: "read_file",
				options: [{ optionId: "yes-once", kind: "allow_once" }],
			},
			makeCtx({
				runtimeMode: "approval-required",
				permissionMode: "plan",
				onRequest: () => {
					requestCount += 1;
				},
			}),
		);
		expect(requestCount).toBe(0);
		expect(result).toMatchObject({ outcome: { outcome: "selected" } });
	});

	it("keeps read-sounding tools automatic in full-access", async () => {
		let requestCount = 0;
		await handleAcpNativePermissionRequest(
			"session/request_permission",
			{ tool: "list_users" },
			makeCtx({
				runtimeMode: "full-access",
				onRequest: () => {
					requestCount += 1;
				},
			}),
		);
		expect(requestCount).toBe(0);
	});

	it("still auto-approves command-classified requests only via policy", async () => {
		let requestCount = 0;
		const result = await handleAcpNativePermissionRequest(
			"session/request_permission",
			{
				tool: "shell",
				command: "npm run build",
				options: [{ optionId: "yes-once", kind: "allow_once" }],
			},
			makeCtx({
				runtimeMode: "approval-required",
				onRequest: () => {
					requestCount += 1;
				},
			}),
		);
		expect(requestCount).toBe(1);
		expect(result).toMatchObject({ outcome: { outcome: "selected" } });
	});
});
