import { Effect } from "effect";
import { beforeEach, expect, it, vi } from "vitest";

const connection = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/rpc-client.ts", () => ({
	getControlPlaneRpcClient: connection,
}));

import {
	peekControlPlaneCache,
	runCachedControlPlane,
	runCachedRead,
	runControlPlane,
} from "../../src/lib/control-plane-client.ts";
import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";

beforeEach(() => {
	connection.mockReset().mockResolvedValue({
		"connect.handshake": () => Effect.succeed({ workspaceScopeProtocol: 1 }),
	});
	observeRendererAccount(null);
	observeRendererAccount("alice");
});

it("does not dispatch a waiting operation under a replacement account", async () => {
	const ready = Promise.withResolvers<object>();
	connection.mockReturnValue(ready.promise);
	const operation = vi.fn(() => Effect.succeed("result"));
	const pending = runControlPlane(operation);
	observeRendererAccount("bob");
	ready.resolve({});
	await expect(pending).rejects.toThrow("connection account changed");
	expect(operation).not.toHaveBeenCalled();
});

it("does not publish an old result after switching away and back", async () => {
	const result = Promise.withResolvers<string>();
	const operation = vi.fn(() => Effect.promise(() => result.promise));
	const pending = runControlPlane(operation);
	await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
	observeRendererAccount("bob");
	observeRendererAccount("alice");
	result.resolve("alice's old result");
	await expect(pending).rejects.toThrow("connection account changed");
});

it("keeps ordinary same-account refreshes and errors unchanged", async () => {
	const pending = runControlPlane(() => Effect.succeed("result"));
	observeRendererAccount("alice");
	await expect(pending).resolves.toBe("result");
	await expect(
		runControlPlane(() => Effect.fail(new Error("provider unavailable"))),
	).rejects.toThrow("provider unavailable");
});

it("does not require authentication for existing signed-out control-plane calls", async () => {
	observeRendererAccount(null);
	await expect(runControlPlane(() => Effect.succeed("status"))).resolves.toBe(
		"status",
	);
});

it("carries scope on each request without changing the account", async () => {
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	await runControlPlane(() => Effect.void);
	expect(connection).toHaveBeenLastCalledWith({
		kind: "organization",
		organizationId: "org_a",
	});
	await runControlPlane(() => Effect.void, {
		scope: "account",
	});
	expect(connection).toHaveBeenLastCalledWith({ kind: "personal" });
});

it("ignores a late result after switching workspaces, including away and back", async () => {
	const result = Promise.withResolvers<string>();
	const operation = vi.fn(() => Effect.promise(() => result.promise));
	const pending = runControlPlane(operation);
	await vi.waitFor(() => expect(operation).toHaveBeenCalledOnce());
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	selectRendererWorkspace({ kind: "personal" });
	result.resolve("old personal result");
	await expect(pending).rejects.toThrow("workspace changed");
});

it("partitions cached reads by workspace and reuses only that workspace's result", async () => {
	const read = vi.fn(() => Effect.succeed("personal"));
	expect(await runCachedControlPlane("cloud.image", read)).toBe("personal");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	read.mockImplementation(() => Effect.succeed("org_a"));
	expect(await runCachedControlPlane("cloud.image", read)).toBe("org_a");
	selectRendererWorkspace({ kind: "personal" });
	expect(await runCachedControlPlane("cloud.image", read)).toBe("personal");
	expect(read).toHaveBeenCalledTimes(2);
});

it("serves a cached read instantly and keeps it per account", async () => {
	const decode = (value: unknown) => value as { members: number };
	const read = vi.fn(async () => ({ members: 2 }));
	await expect(
		runCachedRead("organizations:test", read, { decode, scope: "account" }),
	).resolves.toEqual({ members: 2 });
	expect(
		peekControlPlaneCache("organizations:test", decode, "account"),
	).toEqual({ members: 2 });
	// A background refresh replaces the snapshot without clearing it first.
	read.mockResolvedValueOnce({ members: 3 });
	await runCachedRead("organizations:test", read, {
		decode,
		scope: "account",
		refresh: true,
	});
	expect(
		peekControlPlaneCache("organizations:test", decode, "account"),
	).toEqual({ members: 3 });
	observeRendererAccount("bob");
	expect(
		peekControlPlaneCache("organizations:test", decode, "account"),
	).toBeUndefined();
});
