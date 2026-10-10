import { describe, expect, test, vi } from "vitest";
import {
	drainMailboxLifecycleOutbox,
	mailboxBookkeepingWithDeadline,
	reconcileCloudThenDrainMailboxLifecycleOutbox,
} from "../../src/cloud-mailbox-bookkeeping.ts";
import {
	type CloudMailboxCoordinatorApi,
	coordinateCloudMailboxResponse,
} from "../../src/cloud-mailbox-coordinator.ts";
import {
	attachCloudMailboxBillingDirective,
	attachCloudMailboxCommandDirective,
} from "../../src/cloud-mailbox-directive.ts";
import { hyperdrivePoolConfig } from "../../src/hyperdrive.ts";
import {
	applyResponseEffects,
	type ResponseEffectsApi,
} from "../../src/response-effects.ts";

const responseEffectsApi = (
	overrides: Partial<ResponseEffectsApi> = {},
): ResponseEffectsApi => ({
	dispose: async () => undefined,
	reconcileMachine: async () => ({ claimed: 0, processed: 0 }),
	reconcileCloudBuild: async () => undefined,
	reconcileCloudWorkspaceStartup: async () => ({ kind: "complete" }),
	deliverApiWebhooks: async () => 0,
	...overrides,
});

describe("public workspace response scheduling", () => {
	test("waits for durable startup scheduling before acknowledging a response", async () => {
		let complete!: () => void;
		let entered!: () => void;
		const scheduled = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const scheduling = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const dispose = vi.fn(async () => {});
		const waitUntil = vi.fn();
		let acknowledged = false;
		const response = applyResponseEffects(
			new Response("accepted", {
				status: 202,
				headers: { "x-zuse-reconcile-cloud-workspace": "workspace-1" },
			}),
			responseEffectsApi({
				dispose,
				reconcileCloudWorkspaceStartup: async () => {
					entered();
					await scheduled;
					return { kind: "complete" };
				},
			}),
			async () => undefined,
			{ waitUntil },
		).then((response) => {
			acknowledged = true;
			return response;
		});
		await scheduling;
		expect(acknowledged).toBe(false);
		expect(dispose).not.toHaveBeenCalled();
		expect(waitUntil).not.toHaveBeenCalled();
		complete();
		const result = await response;
		expect(result.status).toBe(202);
		expect(result.headers.has("x-zuse-reconcile-cloud-workspace")).toBe(false);
		expect(dispose).toHaveBeenCalledOnce();
	});
	test("propagates enqueue failure and disposes the request instead of acknowledging", async () => {
		const dispose = vi.fn(async () => {});
		const waitUntil = vi.fn();
		await expect(
			applyResponseEffects(
				new Response(null, {
					status: 202,
					headers: { "x-zuse-reconcile-cloud-workspace": "workspace-1" },
				}),
				responseEffectsApi({
					dispose,
					reconcileCloudWorkspaceStartup: async () => {
						throw new Error("durable queue unavailable");
					},
				}),
				async () => undefined,
				{ waitUntil },
			),
		).rejects.toThrow("durable queue unavailable");
		expect(dispose).toHaveBeenCalledOnce();
		expect(waitUntil).not.toHaveBeenCalled();
	});
	test("retains background ownership for unrelated build work after durable workspace enqueue", async () => {
		let completeBuild!: () => void;
		const build = new Promise<void>((resolve) => {
			completeBuild = resolve;
		});
		const dispose = vi.fn(async () => {});
		const background: Promise<unknown>[] = [];
		const schedule = vi.fn(async () => ({ kind: "complete" as const }));
		const response = await applyResponseEffects(
			new Response(null, {
				status: 202,
				headers: {
					"x-zuse-reconcile-cloud-workspace": "workspace-1",
					"x-zuse-reconcile-cloud-build": "build-1",
				},
			}),
			responseEffectsApi({
				dispose,
				reconcileCloudWorkspaceStartup: schedule,
				reconcileCloudBuild: () => build,
			}),
			async () => undefined,
			{ waitUntil: (work) => background.push(work) },
		);
		expect(response.status).toBe(202);
		expect(schedule).toHaveBeenCalledExactlyOnceWith("workspace-1");
		expect(dispose).not.toHaveBeenCalled();
		expect(background).toHaveLength(1);
		completeBuild();
		await Promise.all(background);
		expect(dispose).toHaveBeenCalledOnce();
	});
});

describe("api worker database lifecycle", () => {
	test("fails connection acquisition instead of leaving requests suspended", () => {
		const config = hyperdrivePoolConfig("postgres://hyperdrive");

		expect(config).toMatchObject({
			connectionString: "postgres://hyperdrive",
			max: 1,
			connectionTimeoutMillis: 5_000,
		});
		expect(config).not.toHaveProperty("maxUses");
	});

	test("bounds post-lease mailbox bookkeeping", async () => {
		vi.useFakeTimers();
		const neverSettles = new Promise<void>(() => undefined);
		const bookkeeping = mailboxBookkeepingWithDeadline(neverSettles, 25);
		const rejected = expect(bookkeeping).rejects.toThrow(
			"cloud mailbox bookkeeping timed out",
		);

		await vi.advanceTimersByTimeAsync(25);
		await rejected;
		vi.useRealTimers();
	});

	test("retries a committed lifecycle fence without a connected client", async () => {
		const lifecycle = {
			workspaceId: "workspace-1",
			action: "archive" as const,
			destructionFence: 4,
		};
		let pending = true;
		let deliveryAttempts = 0;
		const drain = () =>
			drainMailboxLifecycleOutbox({
				list: async () => (pending ? [lifecycle] : []),
				deliver: async () => {
					deliveryAttempts += 1;
					return deliveryAttempts > 1;
				},
				acknowledge: async () => {
					pending = false;
					return true;
				},
			});

		expect(await drain()).toBe(0);
		expect(pending).toBe(true);
		expect(await drain()).toBe(1);
		expect(pending).toBe(false);
		expect(deliveryAttempts).toBe(2);
	});

	test("drains lifecycle fences even when cloud reconciliation fails", async () => {
		const reconciliationError = new Error("unrelated workspace failed");
		const failures: Array<unknown> = [];
		let drained = false;
		const delivered = await reconcileCloudThenDrainMailboxLifecycleOutbox({
			reconcile: async () => Promise.reject(reconciliationError),
			drain: async () => {
				drained = true;
				return 2;
			},
			onReconcileFailure: (cause) => failures.push(cause),
		});

		expect(drained).toBe(true);
		expect(delivered).toBe(2);
		expect(failures).toEqual([reconciliationError]);
	});
});

const coordinatorApi = (
	overrides: Partial<CloudMailboxCoordinatorApi> = {},
): CloudMailboxCoordinatorApi => ({
	dispose: async () => undefined,
	requestCloudMailboxWake: async () => "ready",
	reconcileCloudWorkspaceStartup: async () => ({ kind: "complete" }),
	completeCloudMailboxDrain: async () => true,
	recordCloudMailboxRuntimeProgress: async () => true,
	acknowledgeCloudMailboxLifecycle: async () => true,
	...overrides,
});

describe("api worker mailbox saga", () => {
	test.each([
		"enqueue",
		"unblock",
		"fence",
	] as const)("waits for durable startup before acknowledging mailbox %s", async (path) => {
		let complete!: () => void;
		let entered!: () => void;
		const scheduled = new Promise<void>((resolve) => {
			complete = resolve;
		});
		const scheduling = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const response = new Response(JSON.stringify({ commandId: "command-1" }), {
			status: 202,
		});
		attachCloudMailboxCommandDirective(
			response,
			path === "enqueue"
				? {
						action: "enqueue",
						workspaceId: "workspace-1",
						accountId: "account-1",
					}
				: path === "unblock"
					? { action: "status", workspaceId: "workspace-1" }
					: {
							action: "lease",
							workspaceId: "workspace-1",
							runtimeGeneration: 2,
							wakeRevision: 3,
						},
		);
		if (path !== "enqueue")
			attachCloudMailboxBillingDirective(response, {
				policy: "available",
				accountId: "account-1",
			});
		const dispose = vi.fn(async () => {});
		const waitUntil = vi.fn();
		let acknowledged = false;
		const result = coordinateCloudMailboxResponse({
			response,
			mailboxes: {
				idFromName: (name) => name,
				get: () => ({
					fetch: async (request) =>
						new Response(
							JSON.stringify(
								new URL(request.url).pathname === "/unblock"
									? { unblocked: 1 }
									: {
											nonterminalCount: 1,
											mailboxRevision: 4,
											fenceRequired: true,
										},
							),
							{ status: 200 },
						),
				}),
			},
			mailboxEnabled: true,
			api: coordinatorApi({
				dispose,
				reconcileCloudWorkspaceStartup: async () => {
					entered();
					await scheduled;
					return { kind: "complete" };
				},
			}),
			context: { waitUntil },
		}).then((response) => {
			acknowledged = true;
			return response;
		});
		await scheduling;
		expect(acknowledged).toBe(false);
		expect(dispose).not.toHaveBeenCalled();
		expect(waitUntil).not.toHaveBeenCalled();
		complete();
		expect((await result)?.status).toBe(200);
		expect(dispose).toHaveBeenCalledOnce();
	});
	test.each([
		"enqueue",
		"unblock",
		"fence",
	] as const)("reports durable scheduling failure on mailbox %s without losing command identity", async (path) => {
		const response = new Response(JSON.stringify({ commandId: "command-1" }), {
			status: 202,
		});
		attachCloudMailboxCommandDirective(
			response,
			path === "enqueue"
				? {
						action: "enqueue",
						workspaceId: "workspace-1",
						accountId: "account-1",
					}
				: path === "unblock"
					? { action: "status", workspaceId: "workspace-1" }
					: {
							action: "lease",
							workspaceId: "workspace-1",
							runtimeGeneration: 2,
							wakeRevision: 3,
						},
		);
		if (path !== "enqueue")
			attachCloudMailboxBillingDirective(response, {
				policy: "available",
				accountId: "account-1",
			});
		const accepted: string[] = [];
		const dispose = vi.fn(async () => {});
		const result = await coordinateCloudMailboxResponse({
			response,
			mailboxes: {
				idFromName: (name) => name,
				get: () => ({
					fetch: async (request) => {
						if (new URL(request.url).pathname === "/commit")
							accepted.push(
								((await request.json()) as { commandId: string }).commandId,
							);
						return new Response(
							JSON.stringify(
								new URL(request.url).pathname === "/unblock"
									? { unblocked: 1 }
									: {
											nonterminalCount: 1,
											mailboxRevision: 4,
											fenceRequired: true,
										},
							),
						);
					},
				}),
			},
			mailboxEnabled: true,
			api: coordinatorApi({
				dispose,
				reconcileCloudWorkspaceStartup: async () => {
					throw new Error("durable queue unavailable");
				},
			}),
			context: { waitUntil: () => undefined },
		});
		expect(result?.status).toBe(503);
		expect(accepted).toEqual(path === "enqueue" ? ["command-1"] : []);
		expect(dispose).toHaveBeenCalledOnce();
	});
	test.each([
		false,
		true,
	])("keeps origin approval on mailbox errors (approved=%s)", async (approved) => {
		const response = new Response(JSON.stringify({ commandId: "command-1" }), {
			headers: approved
				? {
						"access-control-allow-origin": "https://code-staging.zuse.sh",
						vary: "Origin",
					}
				: {},
		});
		attachCloudMailboxCommandDirective(response, {
			action: "enqueue",
			workspaceId: "workspace-1",
			accountId: "account-1",
		});
		const fetch = vi.fn(async () => new Response("{}"));
		const result = await coordinateCloudMailboxResponse({
			response,
			mailboxes: { idFromName: (name) => name, get: () => ({ fetch }) },
			mailboxEnabled: false,
			api: coordinatorApi(),
			context: { waitUntil: () => undefined },
		});
		expect(result?.status).toBe(409);
		expect(result?.headers.get("access-control-allow-origin")).toBe(
			approved ? "https://code-staging.zuse.sh" : null,
		);
		expect(await result?.json()).toEqual({
			code: "cloud-command-mailbox-disabled",
		});
		expect(fetch).not.toHaveBeenCalled();
	});
	test.each([
		"enqueue",
		"status",
		"watch",
	] as const)("preserves approved browser CORS on %s responses", async (action) => {
		const routeResponse = new Response(
			JSON.stringify({ commandId: "command-1", afterRevision: 0 }),
			{
				headers: {
					"access-control-allow-origin": "https://code-staging.zuse.sh",
					"access-control-allow-credentials": "true",
					"access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
					"access-control-allow-headers": "authorization, content-type",
					vary: "Origin",
				},
			},
		);
		attachCloudMailboxCommandDirective(
			routeResponse,
			action === "enqueue"
				? { action, workspaceId: "workspace-1", accountId: "account-1" }
				: { action, workspaceId: "workspace-1" },
		);
		if (action !== "enqueue")
			attachCloudMailboxBillingDirective(routeResponse, {
				policy: "available",
				accountId: "account-1",
			});
		const result = await coordinateCloudMailboxResponse({
			response: routeResponse,
			mailboxes: {
				idFromName: (name) => name,
				get: () => ({
					fetch: async () =>
						new Response("{}", {
							status: action === "enqueue" ? 202 : 200,
							headers: {
								"content-type": "application/json",
								vary: "Accept-Encoding",
							},
						}),
				}),
			},
			mailboxEnabled: true,
			api: coordinatorApi(),
			context: { waitUntil: (promise) => void promise },
		});
		expect(result?.status).toBe(action === "enqueue" ? 202 : 200);
		expect(result?.headers.get("access-control-allow-origin")).toBe(
			"https://code-staging.zuse.sh",
		);
		expect(result?.headers.get("access-control-allow-credentials")).toBe(
			"true",
		);
		expect(result?.headers.get("vary")).toContain("Origin");
		expect(result?.headers.get("vary")).toContain("Accept-Encoding");
		expect(await result?.text()).toBe("{}");
	});
	test("accepts before wake and schedules workspace reconciliation", async () => {
		const internalRequests: Array<string> = [];
		const committed = new Response(
			JSON.stringify({ commandId: "command-1", state: "waiting-for-runtime" }),
			{ status: 202, headers: { "content-type": "application/json" } },
		);
		const mailboxes = {
			idFromName: vi.fn((workspaceId: string) => workspaceId),
			get: vi.fn(() => ({
				fetch: async (request: Request) => {
					internalRequests.push(
						`${request.method} ${new URL(request.url).pathname}`,
					);
					return new URL(request.url).pathname === "/commit"
						? committed
						: new Response(null, { status: 200 });
				},
			})),
		};
		const wake = vi.fn(async () => "ready" as const);
		const reconcile = vi.fn(async () => undefined);
		const dispose = vi.fn(async () => undefined);
		const waitUntil: Array<Promise<unknown>> = [];
		const routeResponse = new Response(
			JSON.stringify({ commandId: "command-1" }),
			{ status: 202 },
		);
		attachCloudMailboxCommandDirective(routeResponse, {
			action: "enqueue",
			workspaceId: "workspace-1",
			accountId: "account-1",
		});

		const result = await coordinateCloudMailboxResponse({
			response: routeResponse,
			mailboxes,
			mailboxEnabled: true,
			api: coordinatorApi({
				dispose,
				requestCloudMailboxWake: wake,
				reconcileCloudWorkspaceStartup: reconcile,
			}),
			context: { waitUntil: (promise) => waitUntil.push(promise) },
		});

		expect(result).toBe(committed);
		expect(internalRequests).toEqual(["POST /reserve", "POST /commit"]);
		expect(wake).toHaveBeenNthCalledWith(1, "workspace-1", "account-1");
		expect(wake).toHaveBeenCalledTimes(1);
		expect(reconcile).toHaveBeenCalledOnce();
		expect(waitUntil).toHaveLength(0);
		await Promise.all(waitUntil);
		expect(dispose).toHaveBeenCalledOnce();
	});

	test("forwards a delete-grace runtime acknowledgment without waking", async () => {
		const internalRequests: Array<{
			readonly path: string;
			readonly body: string;
		}> = [];
		const runtimeAcknowledgment = {
			commandId: "leased-command",
			leaseToken: "original-lease-token",
			fingerprint: "hmac-sha256:leased-command",
			state: "applied",
		};
		const routeResponse = new Response(JSON.stringify(runtimeAcknowledgment));
		attachCloudMailboxCommandDirective(routeResponse, {
			action: "ack",
			workspaceId: "workspace-deleting",
		});
		const mailboxResponse = new Response(
			JSON.stringify({ ...runtimeAcknowledgment, revision: 7 }),
			{ headers: { "content-type": "application/json" } },
		);
		const mailboxes = {
			idFromName: (workspaceId: string) => workspaceId,
			get: () => ({
				fetch: async (request: Request) => {
					internalRequests.push({
						path: new URL(request.url).pathname,
						body: await request.text(),
					});
					return mailboxResponse;
				},
			}),
		};
		const wake = vi.fn(async () => "ready" as const);
		const reconcile = vi.fn(async () => undefined);
		const dispose = vi.fn(async () => undefined);

		const result = await coordinateCloudMailboxResponse({
			response: routeResponse,
			mailboxes,
			mailboxEnabled: true,
			api: coordinatorApi({
				dispose,
				requestCloudMailboxWake: wake,
				reconcileCloudWorkspaceStartup: reconcile,
			}),
			context: { waitUntil: () => undefined },
		});

		expect(result).toBe(mailboxResponse);
		expect(internalRequests).toEqual([
			{ path: "/ack", body: JSON.stringify(runtimeAcknowledgment) },
		]);
		expect(wake).not.toHaveBeenCalled();
		expect(reconcile).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledOnce();
	});
});
