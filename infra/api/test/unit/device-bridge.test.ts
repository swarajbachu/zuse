import { Effect, Layer, ManagedRuntime, Redacted } from "effect";
import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CloudWorkspaceRecord } from "../../src/cloud-workspace-store.ts";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { forwardDeviceBridge } from "../../src/device-bridge.ts";
import { ApiStoreMemory } from "../../src/store.ts";

afterEach(() => vi.unstubAllGlobals());
const workspace: CloudWorkspaceRecord = {
	workspaceId: "workspace",
	accountId: "account",
	chatId: "chat",
	initialSessionId: "session",
	projectId: "project",
	buildId: "build",
	provider: "e2b",
	runtimeState: "online",
	branch: "main",
	baseRef: "main",
	state: "ready",
	desiredState: "ready",
	statusCode: "ready",
	idempotencyKey: "key",
	requestConfig: { localDeviceId: "desktop", deviceBridgeVersion: 1 },
	nextActionAtMs: 0,
	revision: 0,
	createdAtMs: 0,
	updatedAtMs: 0,
	lastActivityAtMs: 0,
};
const setup = async () => {
	const dispatch = vi.fn().mockResolvedValue(new Response("{}"));
	const keys = await generateKeyPair("EdDSA", { extractable: true });
	const runtime = ManagedRuntime.make(
		Layer.mergeAll(
			ApiStoreMemory,
			CloudWorkspaceStoreMemory,
			configurationLayer({
				deviceBridgeGateway: async (accountId, request) => {
					if (new URL(request.url).pathname === "/devices")
						return Response.json(
							accountId === "account"
								? [
										{
											deviceId: "desktop",
											label: "Test",
											connected: true,
											revoked: false,
											lastSeen: 0,
										},
									]
								: [],
						);
					return dispatch(request);
				},
				apiIssuer: "https://api.test",
				workosJwksUrl: "https://auth.test/jwks",
				workosIssuer: "https://auth.test",
				mintPrivateKey: Redacted.make(
					JSON.stringify(await exportJWK(keys.privateKey)),
				),
				mintPublicKey: JSON.stringify(await exportJWK(keys.publicKey)),
			}),
		),
	);

	return { runtime, keys, dispatch };
};
describe("device bridge API authority", () => {
	it("signs only the exact operation and binds the account, chat, workspace, and target", async () => {
		const { runtime, keys, dispatch } = await setup();
		try {
			const fetch = vi.fn().mockResolvedValue(new Response("{}"));
			vi.stubGlobal("fetch", fetch);
			const action = {
				_tag: "execute" as const,
				input: { id: "command", command: "pwd", cwd: "/tmp" },
			};
			await runtime.runPromise(
				forwardDeviceBridge(workspace, action, "runtime"),
			);
			const request = dispatch.mock.calls[0]?.[0] as Request;
			expect(request.url).toBe(
				"https://bridge.internal/dispatch?deviceId=desktop",
			);
			const envelope = (await request.json()) as {
				token: string;
				body: string;
			};

			const { payload, protectedHeader } = await jwtVerify(
				envelope.token,
				keys.publicKey,
				{ issuer: "https://api.test", audience: "device-bridge:desktop" },
			);
			expect(protectedHeader.typ).toBe("device-bridge+jwt");
			expect(payload).toMatchObject({
				accountId: "account",
				workspaceId: "workspace",
				chatId: "chat",
				actor: "runtime",
				bodyHash: await Effect.runPromise(sha256Hex(JSON.stringify(action))),
			});
			expect(fetch).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});
	it("rejects redirects without forwarding the bridge credential", async () => {
		const { runtime, dispatch } = await setup();
		try {
			const fetch = vi.fn().mockResolvedValue(
				new Response(null, {
					status: 302,
					headers: { location: "https://other.test" },
				}),
			);
			dispatch.mockImplementation((request: Request) => fetch(request));
			await expect(
				runtime.runPromise(
					forwardDeviceBridge(workspace, { _tag: "status" }, "runtime"),
				),
			).rejects.toThrow();
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(dispatch).toHaveBeenCalledTimes(1);
		} finally {
			await runtime.dispose();
		}
	});
	it("blocks self-approval, other accounts, archived chats, and old runtimes before forwarding", async () => {
		const { runtime, dispatch } = await setup();
		try {
			const fetch = vi.fn();
			vi.stubGlobal("fetch", fetch);
			await expect(
				runtime.runPromise(
					forwardDeviceBridge(
						workspace,
						{ _tag: "decide", id: "cmd", decision: "AlwaysAllow" },
						"runtime",
					),
				),
			).rejects.toThrow();
			await expect(
				runtime.runPromise(
					forwardDeviceBridge(
						{ ...workspace, accountId: "other" },
						{ _tag: "status" },
						"runtime",
					),
				),
			).rejects.toThrow();
			await expect(
				runtime.runPromise(
					forwardDeviceBridge(
						{ ...workspace, desiredState: "archived" },
						{ _tag: "status" },
						"user",
					),
				),
			).rejects.toThrow();
			await expect(
				runtime.runPromise(
					forwardDeviceBridge(
						{ ...workspace, requestConfig: { localDeviceId: "desktop" } },
						{ _tag: "status" },
						"user",
					),
				),
			).rejects.toThrow();
			expect(fetch).not.toHaveBeenCalled();
			expect(dispatch).not.toHaveBeenCalled();
		} finally {
			await runtime.dispose();
		}
	});
	it("changes the target atomically and preserves it against stale workspace saves", async () => {
		const runtime = ManagedRuntime.make(CloudWorkspaceStoreMemory);
		try {
			const store = await runtime.runPromise(CloudWorkspaceStore);
			await runtime.runPromise(
				store.createWorkspace(workspace, {
					workspaceId: workspace.workspaceId,
					accountId: "account",
					chatId: "chat",
					sessionId: "session",
					turnId: "turn",
					commandId: "launch",
					ciphertext: "test",
					expiresAtMs: 9999999999999,
					createdAtMs: 0,
				}),
			);
			const bound = await runtime.runPromise(
				store.bindLocalDevice({
					workspaceId: workspace.workspaceId,
					accountId: "account",
					expectedRevision: 0,
					deviceId: "second",
					nowMs: 100,
				}),
			);
			expect(bound?.requestConfig.localDeviceId).toBe("second");
			expect(
				await runtime.runPromise(
					store.bindLocalDevice({
						workspaceId: workspace.workspaceId,
						accountId: "other",
						expectedRevision: 1,
						deviceId: "third",
						nowMs: 101,
					}),
				),
			).toBeNull();
			await runtime.runPromise(
				store.saveWorkspace({ ...workspace, revision: 2, updatedAtMs: 200 }),
			);
			expect(
				(await runtime.runPromise(store.getWorkspace(workspace.workspaceId)))
					?.requestConfig.localDeviceId,
			).toBe("second");
		} finally {
			await runtime.dispose();
		}
	});
});
