import {
	handleGrokNativePermissionRequest,
	isGrokNativePermissionMethod,
} from "@zuse/agents/drivers/grok";

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
	readonly decision?: PermissionDecision;
	readonly onRequest?: (kind: PermissionKind, forcePrompt: boolean) => void;
}) => ({
	requestPermission: async (
		kind: PermissionKind,
		options: { readonly forcePrompt: boolean },
	): Promise<PermissionDecision> => {
		opts.onRequest?.(kind, options.forcePrompt);
		return opts.decision ?? { _tag: "AllowOnce" };
	},
	getRuntimeMode: () => opts.runtimeMode,
	getPermissionMode: () => opts.permissionMode ?? "default",
});

describe("Grok native ACP permission handling", () => {
	it("recognizes permission-like ACP methods", () => {
		expect(isGrokNativePermissionMethod("permission/request")).toBe(true);
		expect(isGrokNativePermissionMethod("tool/requestApproval")).toBe(true);
		expect(isGrokNativePermissionMethod("tool/canUseTool")).toBe(true);
		expect(isGrokNativePermissionMethod("fs/read_file")).toBe(false);
	});

	it("auto-approves native shell permissions in full-access without prompting", async () => {
		let requestCount = 0;
		const result = await handleGrokNativePermissionRequest(
			"tool/requestApproval",
			{ tool: "Shell", command: "npm install -g eas-cli" },
			makeCtx({
				runtimeMode: "full-access",
				onRequest: () => {
					requestCount += 1;
				},
			}),
		);

		expect(requestCount).toBe(0);
		expect(result).toMatchObject({
			outcome: "approved",
			approved: true,
			allowed: true,
		});
	});

	it("bridges approval-required native shell permissions into PermissionService", async () => {
		const requests: Array<{ kind: PermissionKind; forcePrompt: boolean }> = [];
		const result = await handleGrokNativePermissionRequest(
			"tool/requestApproval",
			{ tool: "Shell", command: "git push origin main" },
			makeCtx({
				runtimeMode: "approval-required",
				onRequest: (kind, forcePrompt) => {
					requests.push({ kind, forcePrompt });
				},
			}),
		);

		expect(requests).toEqual([
			{
				kind: { _tag: "Bash", command: "git push origin main" },
				forcePrompt: false,
			},
		]);
		expect(result).toMatchObject({ outcome: "approved", approved: true });
	});

	it("returns a deny response when the bridged permission is denied", async () => {
		const result = await handleGrokNativePermissionRequest(
			"tool/requestApproval",
			{ toolName: "str_replace", path: "/repo/src/app.ts" },
			makeCtx({
				runtimeMode: "approval-required",
				decision: { _tag: "Deny" },
			}),
		);

		expect(result).toMatchObject({
			outcome: "denied",
			approved: false,
			allowed: false,
		});
	});

	it("silently denies plan-mode native shell permissions", async () => {
		const requests: Array<{ kind: PermissionKind; forcePrompt: boolean }> = [];
		const result = await handleGrokNativePermissionRequest(
			"tool/requestApproval",
			{ tool: "Shell", command: "bun install" },
			makeCtx({
				runtimeMode: "full-access",
				permissionMode: "plan",
				onRequest: (kind, forcePrompt) => {
					requests.push({ kind, forcePrompt });
				},
			}),
		);

		expect(requests).toEqual([]);
		expect(result).toMatchObject({ outcome: "denied", approved: false });
	});

	it("allows plan-mode read requests without prompting", async () => {
		let requestCount = 0;
		for (const params of [
			{ tool: "read_file", path: "/repo/src/app.ts" },
			{ tool: "web_fetch", url: "https://example.com/docs" },
			{ tool: "Shell", command: "rg TODO src" },
		]) {
			const result = await handleGrokNativePermissionRequest(
				"tool/requestApproval",
				params,
				makeCtx({
					runtimeMode: "full-access",
					permissionMode: "plan",
					onRequest: () => {
						requestCount += 1;
					},
				}),
			);
			expect(result).toMatchObject({ outcome: "approved", approved: true });
		}
		expect(requestCount).toBe(0);
	});

	it("does not infer reads from verb substrings in unknown tool names", async () => {
		let requestCount = 0;
		const result = await handleGrokNativePermissionRequest(
			"tool/requestApproval",
			{ tool: "target_window", path: "/repo/src/app.ts" },
			makeCtx({
				runtimeMode: "full-access",
				permissionMode: "plan",
				onRequest: () => {
					requestCount += 1;
				},
			}),
		);

		expect(requestCount).toBe(0);
		expect(result).toMatchObject({ outcome: "denied", approved: false });
	});

	it("keeps sensitive plan-mode file reads behind the protected-path gate", async () => {
		const requests: Array<{ kind: PermissionKind; forcePrompt: boolean }> = [];
		await handleGrokNativePermissionRequest(
			"tool/requestApproval",
			{ tool: "read_file", path: "/repo/.env" },
			makeCtx({
				runtimeMode: "full-access",
				permissionMode: "plan",
				onRequest: (kind, forcePrompt) => {
					requests.push({ kind, forcePrompt });
				},
			}),
		);

		expect(requests).toEqual([
			{
				kind: {
					_tag: "Other",
					tool: "read_file",
					summary: "/repo/.env",
				},
				forcePrompt: true,
			},
		]);
	});

	it("ignores unknown non-permission ACP methods", async () => {
		const result = await handleGrokNativePermissionRequest(
			"collab/ping",
			{ tool: "Shell", command: "pwd" },
			makeCtx({ runtimeMode: "full-access" }),
		);

		expect(result).toBeNull();
	});
});
