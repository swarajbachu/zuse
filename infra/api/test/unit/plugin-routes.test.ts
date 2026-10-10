import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { type PluginResponse, PluginSnapshot } from "@zuse/contracts";
import { Effect, Layer, Redacted } from "effect";
import { afterEach, expect, test, vi } from "vitest";
import {
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configurationLayer } from "../../src/config.ts";
import { sha256Hex } from "../../src/crypto.ts";
import { PluginHost, PluginOperationError } from "../../src/plugin-host.ts";
import { makeCloudflarePluginHost } from "../../src/plugin-host-cloudflare.ts";
import { routePluginRequest } from "../../src/plugin-routes.ts";
import { ApiStoreMemory } from "../../src/store.ts";
import { WorkosVerifierTest } from "../../src/workos.ts";

const requestHost = vi.fn(
	async (..._args: unknown[]): Promise<PluginResponse> => ({ kind: "ok" }),
);
const layer = Layer.mergeAll(
	configurationLayer({
		apiIssuer: "https://api.test",
		workosJwksUrl: "https://unused.test",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("unused"),
		mintPublicKey: "unused",
		allowedBrowserOrigins: ["https://code.test"],
		organizationWorkspacesEnabled: true,
		workosApiKey: Redacted.make("test"),
	}),
	WorkosVerifierTest,
	ApiStoreMemory,
	CloudWorkspaceStoreMemory,
	Layer.succeed(PluginHost, {
		request: requestHost,
		tools: async () => [],
		callback: async () => new Response("callback"),
	}),
);
afterEach(() => vi.unstubAllGlobals());

const mockMember = (role = "admin", active = true) =>
	vi.stubGlobal("fetch", async () =>
		Response.json({
			data: active
				? [
						{
							id: "membership",
							user_id: "alice",
							organization_id: "team",
							status: "active",
							role: { slug: role },
						},
					]
				: [],
			list_metadata: { after: null },
		}),
	);

const send = (
	body: unknown,
	authorization?: string,
	origin?: string,
	path = "/v1/plugins",
	scope?: string,
) =>
	Effect.runPromise(
		routePluginRequest(
			new Request(`https://api.test${path}`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(scope ? { "x-zuse-workspace": scope } : {}),
					...(authorization ? { authorization } : {}),
					...(origin ? { origin } : {}),
				},
				body: JSON.stringify(body),
			}),
		).pipe(Effect.provide(layer), Effect.result),
	);
test("management rejects missing auth and another tenant before reaching storage", async () => {
	requestHost.mockClear();
	expect((await send({ action: "list" }))._tag).toBe("Failure");
	expect(
		(
			await send(
				{ action: "list", tenantId: "personal:bob" },
				"Bearer test-token:alice",
			)
		)._tag,
	).toBe("Failure");
	expect(requestHost).not.toHaveBeenCalled();
});
test("rejects an untrusted browser origin and invalid runtime credentials", async () => {
	requestHost.mockClear();
	expect(
		(
			await send(
				{ action: "list" },
				"Bearer test-token:alice",
				"https://evil.test",
			)
		)._tag,
	).toBe("Failure");
	expect(
		(
			await send(
				{ action: "search", query: "" },
				"Bearer invalid",
				undefined,
				"/v1/plugins/runtime/workspace/tools",
			)
		)._tag,
	).toBe("Failure");
	expect(requestHost).not.toHaveBeenCalled();
});

test("binds personal and organization requests to the verified subject", async () => {
	mockMember();
	requestHost.mockClear();
	expect((await send({ action: "list" }, "Bearer test-token:alice"))._tag).toBe(
		"Success",
	);
	expect(requestHost).toHaveBeenLastCalledWith(
		{ tenant: "personal:alice", subject: "alice" },
		{ action: "list" },
	);
	expect(
		(
			await send(
				{ action: "list", tenantId: "organization:team" },
				"Bearer test-token:alice:team",
			)
		)._tag,
	).toBe("Success");
	expect(requestHost).toHaveBeenLastCalledWith(
		{ tenant: "organization:team", subject: "alice" },
		{ action: "list", tenantId: "organization:team" },
	);
});

test("rejects oversized chunked requests before dispatch", async () => {
	requestHost.mockClear();
	expect(
		(
			await send(
				{ action: "connect", label: "x".repeat(130_000) },
				"Bearer test-token:alice",
			)
		)._tag,
	).toBe("Failure");
	expect(requestHost).not.toHaveBeenCalled();
});

test("surfaces readable plugin failure codes and hides other failures", async () => {
	requestHost.mockRejectedValueOnce(
		new PluginOperationError({
			code: "plugin_client_registration_unsupported",
		}),
	);
	const connect = {
		action: "connect",
		tenantId: "personal:alice",
		pluginId: "github",
		label: "GitHub",
		requestId: crypto.randomUUID(),
		returnTo: { kind: "desktop", port: 8976 },
	};
	const failed = await send(connect, "Bearer test-token:alice");
	expect(failed._tag === "Failure" && failed.failure).toMatchObject({
		code: "plugin_client_registration_unsupported",
		status: 400,
	});
	requestHost.mockRejectedValueOnce(new Error("upstream detail"));
	const opaque = await send(connect, "Bearer test-token:alice");
	expect(opaque._tag === "Failure" && opaque.failure).toMatchObject({
		code: "plugin_operation_failed",
	});
	requestHost.mockClear();
	const port = await send(
		{ ...connect, returnTo: { kind: "desktop", port: 8080 } },
		"Bearer test-token:alice",
	);
	expect(port._tag === "Failure" && port.failure).toMatchObject({
		code: "invalid_plugin_request",
	});
	expect(requestHost).not.toHaveBeenCalled();
});

test("the Durable Object host forwards only known failure codes", async () => {
	const host = (error: string) =>
		makeCloudflarePluginHost({
			idFromName: () => ({}),
			get: () => ({
				fetch: async () => Response.json({ error }, { status: 400 }),
			}),
		} as unknown as DurableObjectNamespace);
	const identity = { tenant: "personal:alice", subject: "alice" };
	await expect(
		host("plugin_unreachable").request(identity, { action: "list" }),
	).rejects.toEqual(new PluginOperationError({ code: "plugin_unreachable" }));
	await expect(
		host("secret upstream detail").request(identity, { action: "list" }),
	).rejects.toEqual(
		new PluginOperationError({ code: "plugin_operation_failed" }),
	);
});

test("organization tools follow workspace scope, verify membership without an org claim, and reject mismatches", async () => {
	mockMember("member");
	const tools = vi.fn(async (..._args: unknown[]) => []);
	const scoped = Layer.provideMerge(
		Layer.succeed(PluginHost, {
			request: requestHost,
			tools,
			callback: async () => new Response(),
		}),
		layer,
	);
	const run = (scope: string) =>
		Effect.runPromise(
			routePluginRequest(
				new Request("https://api.test/v1/plugins/tools", {
					method: "POST",
					headers: {
						authorization: "Bearer test-token:alice",
						"x-zuse-workspace": scope,
					},
					body: JSON.stringify({ action: "list" }),
				}),
			).pipe(Effect.provide(scoped), Effect.result),
		);
	expect((await run("organization:team"))._tag).toBe("Success");
	expect(tools).toHaveBeenLastCalledWith(
		{ tenant: "organization:team", subject: "alice" },
		{ action: "list" },
	);
	requestHost.mockClear();
	expect(
		(
			await send(
				{ action: "list", tenantId: "personal:alice" },
				"Bearer test-token:alice",
				undefined,
				"/v1/plugins",
				"organization:team",
			)
		)._tag,
	).toBe("Failure");
	expect(
		(
			await send(
				{
					action: "disconnect",
					tenantId: "organization:team",
					connectionId: "id",
				},
				"Bearer test-token:alice",
				undefined,
				"/v1/plugins",
				"organization:team",
			)
		)._tag,
	).toBe("Failure");
	expect(requestHost).not.toHaveBeenCalled();
	mockMember("member", false);
	expect((await run("organization:team"))._tag).toBe("Failure");
});

test("runtime plugins use the persisted organization owner and reject expired and deleted runtime credentials", async () => {
	const tools = vi.fn(async (..._args: unknown[]) => []);
	const scoped = Layer.provideMerge(
		Layer.succeed(PluginHost, {
			request: requestHost,
			tools,
			callback: async () => new Response(),
		}),
		layer,
	);
	await Effect.runPromise(
		Effect.gen(function* () {
			const store = yield* CloudWorkspaceStore;
			const now = Date.now();
			const record = {
				workspaceId: "org-runtime",
				accountId: "organization:team",
				projectId: "project",
				buildId: "build",
				provider: "fake",
				runtimeState: "online" as const,
				chatId: "chat",
				initialSessionId: "session",
				branch: "task",
				baseRef: "main",
				state: "ready" as const,
				desiredState: "ready" as const,
				statusCode: "ready",
				idempotencyKey: "plugins",
				requestConfig: { runtimeCredentialExpiresAtMs: now + 60000 },
				runtimeCredentialHash: yield* sha256Hex("runtime-token"),
				nextActionAtMs: now,
				revision: 1,
				createdAtMs: now,
				updatedAtMs: now,
				lastActivityAtMs: now,
			};
			yield* store.createWorkspace(record, {
				workspaceId: record.workspaceId,
				accountId: record.accountId,
				chatId: record.chatId,
				sessionId: record.initialSessionId,
				turnId: "turn",
				commandId: "command",
				ciphertext: "sealed",
				expiresAtMs: now + 60000,
				createdAtMs: now,
			});
			const request = () =>
				new Request("https://api.test/v1/plugins/runtime/org-runtime/tools", {
					method: "POST",
					headers: {
						authorization: "Bearer runtime-token",
						"x-zuse-workspace": "personal",
					},
					body: JSON.stringify({ action: "list" }),
				});
			expect(
				(yield* routePluginRequest(request()).pipe(Effect.result))._tag,
			).toBe("Success");
			expect(tools).toHaveBeenLastCalledWith(
				{ tenant: "organization:team", subject: "organization:team" },
				{ action: "list" },
			);
			yield* store.saveWorkspace({
				...record,
				requestConfig: { runtimeCredentialExpiresAtMs: now - 1 },
				revision: 2,
			});
			expect(
				(yield* routePluginRequest(request()).pipe(Effect.result))._tag,
			).toBe("Failure");
			yield* store.saveWorkspace({
				...record,
				desiredState: "deleted",
				revision: 3,
			});
			expect(
				(yield* routePluginRequest(request()).pipe(Effect.result))._tag,
			).toBe("Failure");
			expect(tools).toHaveBeenCalledTimes(1);
		}).pipe(Effect.provide(scoped)),
	);
});

test("organization snapshots expose admin management permissions while members can list", async () => {
	for (const role of ["member", "admin"]) {
		mockMember(role);
		requestHost.mockResolvedValueOnce(
			PluginSnapshot.make({
				kind: "snapshot",
				tenantId: "organization:team",
				tenants: [],
				catalog: [],
				connections: [],
				endpoint: "",
			}),
		);
		const result = await send(
			{ action: "list", tenantId: "organization:team" },
			"Bearer test-token:alice",
		);
		expect(result._tag).toBe("Success");
		if (result._tag !== "Success" || result.success === null)
			throw new Error("Expected snapshot response");
		expect((await result.success.json()).canManage).toBe(role === "admin");
	}
});
