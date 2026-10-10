import { describe, expect, it, vi } from "vitest";
import {
	type CloudMailboxCoordinatorApi,
	coordinateCloudMailboxResponse,
} from "../../src/cloud-mailbox-coordinator.ts";
import {
	attachCloudMailboxBillingDirective,
	attachCloudMailboxCommandDirective,
} from "../../src/cloud-mailbox-directive.ts";

const run = async (input: {
	waitOnly?: boolean;
	lease?: object;
	watch?: object;
}) => {
	const response = Response.json({
		storageIncarnationId: "storage-1",
		waitMs: 25_000,
		afterRevision: 7,
		waitOnly: input.waitOnly === true,
	});
	attachCloudMailboxCommandDirective(response, {
		action: "lease",
		workspaceId: "workspace-1",
		runtimeGeneration: 4,
		...(input.waitOnly ? {} : { wakeRevision: 2 }),
	});
	attachCloudMailboxBillingDirective(response, {
		policy: "available",
		accountId: "account-1",
	});
	const api: CloudMailboxCoordinatorApi = {
		dispose: vi.fn(async () => {}),
		requestCloudMailboxWake: vi.fn(async (): Promise<"ready"> => "ready"),
		reconcileCloudWorkspaceStartup: vi.fn(async () => {}),
		completeCloudMailboxDrain: vi.fn(async () => true),
		recordCloudMailboxRuntimeProgress: vi.fn(async () => true),
		acknowledgeCloudMailboxLifecycle: vi.fn(async () => true),
	};
	const calls: string[] = [];
	const pending: Promise<unknown>[] = [];
	const result = await coordinateCloudMailboxResponse({
		response,
		mailboxEnabled: true,
		api,
		context: {
			waitUntil: (promise) => {
				pending.push(promise);
			},
		},
		mailboxes: {
			idFromName: (name) => name,
			get: () => ({
				fetch: async (request) => {
					const url = new URL(request.url);
					calls.push(`${url.pathname}${url.search}`);
					if (url.pathname === "/watch")
						return Response.json(
							input.watch ?? {
								nextRevision: 9,
								changes: [{ ciphertext: "must-not-return-command-bodies" }],
							},
						);
					if (url.pathname === "/lease")
						return Response.json(
							input.lease ?? {
								leases: [],
								nonterminalCount: 0,
								mailboxRevision: 8,
							},
						);
					return Response.json({});
				},
			}),
		},
	});
	await Promise.all(pending);
	return { result, calls, api };
};

describe("runtime mailbox notification-only long poll", () => {
	it("waits on the idle cursor without granting a lease and returns no command bodies", async () => {
		const { result, calls, api } = await run({ waitOnly: true });
		expect(calls).toEqual(["/unblock", "/watch?afterRevision=7"]);
		expect(await result?.json()).toEqual({
			leases: [],
			mailboxRevision: 9,
			waited: true,
		});
		expect(api.dispose).toHaveBeenCalledOnce();
		expect(api.requestCloudMailboxWake).not.toHaveBeenCalled();
	});
	it("finishes an empty drain then waits at that exact revision without leasing again under stale authorization", async () => {
		const { result, calls, api } = await run({});
		expect(calls).toEqual(["/unblock", "/lease", "/watch?afterRevision=8"]);
		expect(api.completeCloudMailboxDrain).toHaveBeenCalledWith(
			"workspace-1",
			"account-1",
			4,
			2,
		);
		expect(await result?.json()).toMatchObject({ waited: true, leases: [] });
	});
	it("returns an already granted lease immediately without waiting", async () => {
		const page = {
			leases: [{ leaseToken: "granted" }],
			nonterminalCount: 1,
			mailboxRevision: 8,
		};
		const { result, calls } = await run({ lease: page });
		expect(calls).toEqual(["/unblock", "/lease"]);
		expect(await result?.json()).toEqual(page);
	});
	it("rejects invalid watch metadata instead of causing a guest polling loop", async () => {
		const { result } = await run({
			waitOnly: true,
			watch: { nextRevision: -1 },
		});
		expect(result?.status).toBe(503);
	});
	it("does not wait when ownership needs fencing even if the mailbox is empty", async () => {
		const { calls, api } = await run({
			lease: {
				leases: [],
				nonterminalCount: 0,
				mailboxRevision: 8,
				fenceRequired: true,
			},
		});
		expect(calls).toEqual(["/unblock", "/lease"]);
		expect(api.reconcileCloudWorkspaceStartup).toHaveBeenCalledOnce();
	});
});
