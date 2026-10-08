import {
	ApiPaths,
	CloudWorkspaceForkRequest,
	CloudWorkspaceOpError,
	SessionId,
} from "@zuse/contracts";
import { Effect, Schema, Stream } from "effect";
import { describe, expect, it, test, vi } from "vitest";
import {
	type CloudControlRequest,
	makeCloudControlClient,
	streamCloudWorkspaceLifecycle,
} from "../../src/cloud-control-client.ts";

describe("cloud control HTTP routing", () => {
	it("uses the dedicated fork endpoint and never falls back to image creation on failure", async () => {
		const calls = vi.fn();
		const request: CloudControlRequest = (...args) => {
			calls(...args);
			return Effect.die("old API: endpoint not found");
		};
		const client = makeCloudControlClient(request);
		const input = CloudWorkspaceForkRequest.make({
			projectId: "project",
			providerId: "boxd",
			baseRef: "parent-local-branch",
			agent: "codex",
			model: "model",
			idempotencyKey: "fork-once",
			forkSource: {
				workspaceId: "parent",
				sessionId: SessionId.make("source"),
				messageId: "point",
			},
		});
		await expect(
			Effect.runPromise(client["cloud.workspaces.fork"](input)),
		).rejects.toThrow();
		expect(calls).toHaveBeenCalledTimes(1);
		expect(calls).toHaveBeenCalledWith(
			"/v1/cloud/workspaces/fork",
			expect.anything(),
			"POST",
			input,
		);
	});

	it("preserves provider selection and idempotent lifecycle command IDs", async () => {
		const calls = vi.fn();
		const request: CloudControlRequest = (...args) => {
			calls(...args);
			return Effect.die("record only");
		};
		const client = makeCloudControlClient(request);
		client["cloud.image.status"]({ providerId: "provider/one" });
		expect(calls.mock.calls.at(-1)?.[0]).toBe(
			"/v1/cloud/image?providerId=provider%2Fone",
		);
		const input = { workspaceId: "workspace/one", commandId: "stable" };
		client["cloud.workspaces.archive"](input);
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/cloud/workspaces/workspace%2Fone/archive",
			expect.anything(),
			"POST",
			input,
		);
		client["cloud.workspaces.list"]({ projectId: "project one" });
		expect(calls.mock.calls.at(-1)?.[0]).toBe(
			"/v1/cloud/workspaces?projectId=project%20one",
		);
	});
	it("routes agent setup and subscription to account endpoints", () => {
		const calls = vi.fn();
		const request: CloudControlRequest = (...args) => {
			calls(...args);
			return Effect.die("record only");
		};
		const client = makeCloudControlClient(request);
		client["cloud.auth.provision"]();
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/cloud/auth/provision",
			expect.anything(),
			"POST",
			{},
		);
		client["machines.entitlements"]();
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/billing/entitlements",
			expect.anything(),
		);
		client["cloud.github.install"]();
		expect(calls).toHaveBeenLastCalledWith(
			"/v1/cloud/github/install",
			expect.anything(),
			"POST",
			{},
		);
	});
});

test.each([
	"not-allowed",
	"not-found",
	"invalid-request",
	"entitlement-required",
	"billing-hold",
	"conflict",
] as const)("lifecycle subscriptions stop on %s instead of retrying indefinitely", async (code) => {
	let reads = 0;
	const denied = new CloudWorkspaceOpError({ code });
	const read = Effect.suspend(() => {
		reads++;
		return Effect.fail(denied);
	});
	const failure = await Effect.runPromise(
		streamCloudWorkspaceLifecycle(read).pipe(Stream.runCollect, Effect.flip),
	);
	expect(failure).toBe(denied);
	expect(reads).toBe(1);
});

test("cloud management preserves billing, repository, and lifecycle mutation payloads", async () => {
	const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
	const client = makeCloudControlClient((path, _schema, method, body) => {
		calls.push({ path, method, body });
		return Effect.die("request captured");
	});
	const checkout = { offerId: "cloud-workspace" };
	const cap = { overageCapMicros: 5_000_000, idempotencyKey: "cap:1" };
	const repository = {
		repositoryUrl: "https://github.com/team/repo",
		defaultBranch: "main",
		visibility: "private" as const,
		idempotencyKey: "repo:1",
	};
	const deletion = { workspaceId: "workspace/a", commandId: "delete:1" };
	const effects: Array<Effect.Effect<unknown, unknown>> = [
		client["machines.checkout"](checkout),
		client["machines.billingPortal"](),
		client["cloud.billing.setCap"](cap),
		client["cloud.github.install"](),
		client["cloud.github.disconnect"]({ installationId: 42 }),
		client["cloud.projects.connect"](repository),
		client["cloud.projects.remove"]({ projectId: "project/a" }),
		client["cloud.workspaces.list"]({ projectId: "project/a&b" }),
		client["cloud.workspaces.delete"](deletion),
	];
	for (const effect of effects) await Effect.runPromiseExit(effect);
	expect(calls).toEqual([
		{ path: ApiPaths.billingCheckout, method: "POST", body: checkout },
		{ path: ApiPaths.billingPortal, method: "POST", body: {} },
		{ path: ApiPaths.cloudBillingCap, method: "POST", body: cap },
		{ path: ApiPaths.cloudGithubInstall, method: "POST", body: {} },
		{
			path: ApiPaths.cloudGithubDisconnect(42),
			method: "DELETE",
			body: undefined,
		},
		{ path: ApiPaths.cloudProjects, method: "POST", body: repository },
		{
			path: ApiPaths.cloudProject("project/a"),
			method: "DELETE",
			body: undefined,
		},
		{
			path: `${ApiPaths.cloudWorkspaces}?projectId=project%2Fa%26b`,
			method: undefined,
			body: undefined,
		},
		{
			path: ApiPaths.cloudWorkspaceAction("workspace/a", "delete"),
			method: "POST",
			body: deletion,
		},
	]);
});

test("cloud setup reads use the existing API endpoints and preserve provider and usage filters", async () => {
	const calls: string[] = [];
	const client = makeCloudControlClient((path) => {
		calls.push(path);
		return Effect.die("request captured");
	});
	const effects: Array<Effect.Effect<unknown, unknown>> = [
		client["cloud.providers"](),
		client["machines.entitlements"](),
		client["cloud.github.status"](),
		client["cloud.billing.summary"](),
		client["cloud.billing.usage"]({ cursor: "a/b&c", limit: 20 }),
		client["cloud.image.status"]({ providerId: "provider/a" }),
	];
	for (const effect of effects) await Effect.runPromiseExit(effect);
	expect(calls).toEqual([
		ApiPaths.cloudProviders,
		ApiPaths.billingEntitlements,
		ApiPaths.cloudGithub,
		ApiPaths.cloudBillingSummary,
		`${ApiPaths.cloudBillingUsage}?cursor=a%2Fb%26c&limit=20`,
		`${ApiPaths.cloudAccountImage}?providerId=provider%2Fa`,
	]);
});

test("workspace settings retain the revision through the shared HTTP transport", async () => {
	const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
	const settings = { revision: 8, values: { branchNamingPrefix: "team" } };
	const client = makeCloudControlClient((path, schema, method, body) => {
		calls.push({ path, method, body });
		return Schema.decodeUnknownEffect(schema)(settings).pipe(Effect.orDie);
	});
	expect(await Effect.runPromise(client["cloud.settings.get"]())).toEqual(
		settings,
	);
	const input = { expectedRevision: 7, values: settings.values };
	expect(
		await Effect.runPromise(client["cloud.settings.update"](input)),
	).toEqual(settings);
	expect(calls).toEqual([
		{ path: ApiPaths.cloudSettings, method: undefined, body: undefined },
		{ path: ApiPaths.cloudSettings, method: "PUT", body: input },
	]);
});

test("sharing uses the existing control transport and preserves revision and membership grants", async () => {
	const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
	const defaults = { audience: "private", permission: "view" } as const;
	const state = {
		policy: {
			...defaults,
			creatorSubject: "alice",
			creatorMembershipId: "membership-alice",
			grants: [],
		},
		revision: 3,
		canManageSharing: true,
	};
	const client = makeCloudControlClient((path, schema, method, body) => {
		calls.push({ path, method, body });
		return Schema.decodeUnknownEffect(schema)(
			path === ApiPaths.cloudSharingDefaults ? defaults : state,
		).pipe(Effect.orDie);
	});
	await expect(
		Effect.runPromise(
			client["cloud.sharing.get"]({ workspaceId: "workspace/a" }),
		),
	).resolves.toEqual(state);
	const update = {
		...defaults,
		expectedRevision: 3,
		grants: [{ membershipId: "membership-bob", permission: "view" as const }],
	};
	await Effect.runPromise(
		client["cloud.sharing.update"]({ workspaceId: "workspace/a", ...update }),
	);
	await Effect.runPromise(client["cloud.sharing.defaults.get"]());
	await Effect.runPromise(client["cloud.sharing.defaults.update"](defaults));
	expect(calls).toEqual([
		{
			path: ApiPaths.cloudWorkspaceSharing("workspace/a"),
			method: undefined,
			body: undefined,
		},
		{
			path: ApiPaths.cloudWorkspaceSharing("workspace/a"),
			method: "PUT",
			body: update,
		},
		{ path: ApiPaths.cloudSharingDefaults, method: undefined, body: undefined },
		{ path: ApiPaths.cloudSharingDefaults, method: "PUT", body: defaults },
	]);
});

test("saved image deletion targets an exact snapshot identity for safe retries", async () => {
	const calls: Array<{ path: string; method?: string; body?: unknown }> = [];
	const client = makeCloudControlClient((path, _schema, method, body) => {
		calls.push({ path, method, body });
		return Effect.die("captured");
	});
	const input = { snapshotId: "zuse-image-old" };
	await Effect.runPromiseExit(client["cloud.image.delete"](input));
	await Effect.runPromiseExit(client["cloud.image.delete"](input));
	expect(calls).toEqual(
		Array(2).fill({
			path: ApiPaths.cloudAccountImageDelete,
			method: "POST",
			body: input,
		}),
	);
});
