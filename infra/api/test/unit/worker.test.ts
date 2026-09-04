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
import { attachCloudMailboxCommandDirective } from "../../src/cloud-mailbox-directive.ts";
import { hyperdrivePoolConfig } from "../../src/hyperdrive.ts";

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
	reconcileCloudWorkspaceStartup: async () => undefined,
	completeCloudMailboxDrain: async () => true,
	recordCloudMailboxRuntimeProgress: async () => true,
	acknowledgeCloudMailboxLifecycle: async () => true,
	...overrides,
});

describe("api worker mailbox saga", () => {
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
		expect(wake).toHaveBeenNthCalledWith(2, "workspace-1", "account-1");
		expect(reconcile).toHaveBeenCalledOnce();
		expect(waitUntil).toHaveLength(1);
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
