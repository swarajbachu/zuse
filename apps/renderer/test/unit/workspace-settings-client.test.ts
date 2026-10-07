import { CloudWorkspaceOpError, RpcAccessDeniedError } from "@zuse/contracts";
import { Effect } from "effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	read: vi.fn(),
	write: vi.fn(),
	legacy: vi.fn(),
	hosted: false,
	desktop: true,
}));
vi.mock("../../src/lib/settings-client-bus.ts", () => ({
	readPersonalSettingsForMigration: mocks.legacy,
}));
vi.mock("../../src/lib/platform-capabilities.ts", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../src/lib/platform-capabilities.ts")
	>()),
	isHostedProduct: () => mocks.hosted,
	rendererPlatformCapabilities: () => ({
		desktop: mocks.desktop && !mocks.hosted,
	}),
}));
vi.mock("../../src/lib/cloud-control-client.ts", () => ({
	getCloudControlClient: async () => ({
		"cloud.settings.get": mocks.read,
		"cloud.settings.update": mocks.write,
	}),
}));

import { observeRendererAccount } from "../../src/lib/renderer-account.ts";
import { selectRendererWorkspace } from "../../src/lib/renderer-workspace.ts";
import {
	loadWorkspaceSettings,
	retainWorkspaceSettings,
	updateWorkspaceSettings,
	usesAccountWorkspaceSettings,
	useWorkspaceSettingsState,
} from "../../src/lib/workspace-settings-client.ts";

beforeEach(() => {
	vi.stubEnv("VITE_ORGANIZATION_WORKSPACES", "true");
	mocks.hosted = false;
	mocks.desktop = true;
	mocks.legacy.mockReset().mockResolvedValue({ branchNamingPrefix: "legacy" });
	observeRendererAccount(null);
	observeRendererAccount("alice");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	mocks.read
		.mockReset()
		.mockReturnValue(
			Effect.succeed({ revision: 1, values: { branchNamingPrefix: "a" } }),
		);
	mocks.write.mockReset().mockImplementation((input) =>
		Effect.succeed({
			revision: input.expectedRevision + 1,
			values: input.values,
		}),
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

it("leaves native Personal settings on the legacy path until scoped-client rollout is enabled", async () => {
	vi.stubEnv("VITE_ZUSE_API_URL", "https://api.zuse.sh");
	vi.stubEnv("VITE_ORGANIZATION_WORKSPACES", "false");
	selectRendererWorkspace({ kind: "personal" });
	expect(usesAccountWorkspaceSettings()).toBe(false);
	mocks.read.mockReturnValue(Effect.succeed({ revision: 0, values: {} }));
	await loadWorkspaceSettings();
	expect(mocks.legacy).not.toHaveBeenCalled();
	expect(mocks.write).not.toHaveBeenCalled();
});

it("does not import a directly connected Serve browser's runtime into account settings", async () => {
	mocks.desktop = false;
	selectRendererWorkspace({ kind: "personal" });
	expect(usesAccountWorkspaceSettings()).toBe(false);
	mocks.read.mockReturnValue(Effect.succeed({ revision: 0, values: {} }));
	await loadWorkspaceSettings();
	expect(mocks.legacy).not.toHaveBeenCalled();
	expect(mocks.write).not.toHaveBeenCalled();
});

it("initializes empty Personal settings once using only shared non-secret fields", async () => {
	selectRendererWorkspace({ kind: "personal" });
	mocks.read.mockReturnValue(Effect.succeed({ revision: 0, values: {} }));
	mocks.legacy.mockResolvedValue({
		branchNamingPrefix: "legacy",
		appearanceMode: "dark",
		providerBinaryPaths: { codex: "/private/bin" },
		opencodeCustomProviders: [{ apiKey: "never-upload" }],
	});
	expect(await loadWorkspaceSettings()).toEqual({
		revision: 1,
		values: { branchNamingPrefix: "legacy" },
	});
	expect(mocks.write).toHaveBeenCalledWith({
		expectedRevision: 0,
		values: { branchNamingPrefix: "legacy" },
	});
	await loadWorkspaceSettings();
	expect(mocks.legacy).toHaveBeenCalledOnce();
	expect(mocks.write).toHaveBeenCalledOnce();
});

it("adopts existing Personal settings without reading or overwriting local settings", async () => {
	selectRendererWorkspace({ kind: "personal" });
	expect((await loadWorkspaceSettings()).revision).toBe(1);
	expect(mocks.legacy).not.toHaveBeenCalled();
	expect(mocks.write).not.toHaveBeenCalled();
});

it("adopts another device's initialization when migration loses the revision race", async () => {
	selectRendererWorkspace({ kind: "personal" });
	mocks.read
		.mockReturnValueOnce(Effect.succeed({ revision: 0, values: {} }))
		.mockReturnValueOnce(
			Effect.succeed({
				revision: 1,
				values: { branchNamingPrefix: "other-device" },
			}),
		);
	mocks.write.mockReturnValueOnce(
		Effect.fail(new CloudWorkspaceOpError({ code: "conflict" })),
	);
	expect((await loadWorkspaceSettings()).values.branchNamingPrefix).toBe(
		"other-device",
	);
	expect(mocks.write).toHaveBeenCalledOnce();
	expect(mocks.read).toHaveBeenCalledTimes(2);
});

it.each([
	"account",
	"workspace",
])("does not upload legacy settings after the %s changes", async (change) => {
	selectRendererWorkspace({ kind: "personal" });
	mocks.read.mockReturnValue(Effect.succeed({ revision: 0, values: {} }));
	const pending = Promise.withResolvers<object>();
	mocks.legacy.mockReturnValue(pending.promise);
	const loading = loadWorkspaceSettings();
	await vi.waitFor(() => expect(mocks.legacy).toHaveBeenCalledOnce());
	if (change === "account") observeRendererAccount("bob");
	else
		selectRendererWorkspace({ kind: "organization", organizationId: "org_b" });
	pending.resolve({ branchNamingPrefix: "alice" });
	await expect(loading).rejects.toThrow("changed");
	expect(mocks.write).not.toHaveBeenCalled();
});

it("never imports a desktop's settings into browser Personal or an organization", async () => {
	mocks.read.mockReturnValue(Effect.succeed({ revision: 0, values: {} }));
	await loadWorkspaceSettings();
	mocks.hosted = true;
	selectRendererWorkspace({ kind: "personal" });
	await loadWorkspaceSettings();
	expect(mocks.legacy).not.toHaveBeenCalled();
	expect(mocks.write).not.toHaveBeenCalled();
});

it.each([
	new CloudWorkspaceOpError({ code: "not-allowed" }),
	new RpcAccessDeniedError({ code: "credential-expired" }),
])("restores only the same account's acknowledged Personal cache and removes it on denial: %s", async (denied) => {
	const entries = new Map<string, string>();
	vi.stubGlobal("window", {
		localStorage: {
			getItem: (key: string) => entries.get(key) ?? null,
			setItem: (key: string, value: string) => entries.set(key, value),
			removeItem: (key: string) => entries.delete(key),
		},
	});
	selectRendererWorkspace({ kind: "personal" });
	await loadWorkspaceSettings();
	expect(entries.size).toBe(1);
	observeRendererAccount("bob");
	mocks.read.mockReturnValue(
		Effect.fail(new CloudWorkspaceOpError({ code: "provider-unavailable" })),
	);
	await expect(loadWorkspaceSettings()).rejects.toThrow();
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
	observeRendererAccount("alice");
	await expect(loadWorkspaceSettings()).resolves.toEqual({
		revision: 1,
		values: { branchNamingPrefix: "a" },
	});
	expect(useWorkspaceSettingsState.getState().origin).toBe("cache");
	expect(useWorkspaceSettingsState.getState().data).toEqual({
		revision: 1,
		values: { branchNamingPrefix: "a" },
	});
	mocks.read.mockReturnValue(Effect.fail(denied));
	await expect(loadWorkspaceSettings(true)).rejects.toThrow();
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
	expect(entries.size).toBe(0);
	expect(useWorkspaceSettingsState.getState().origin).toBe("none");
});

it("deduplicates reads and exposes no previous organization's settings while loading", async () => {
	await Promise.all([loadWorkspaceSettings(), loadWorkspaceSettings()]);
	expect(mocks.read).toHaveBeenCalledTimes(1);
	selectRendererWorkspace({ kind: "organization", organizationId: "org_b" });
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
	mocks.read.mockReturnValue(Effect.succeed({ revision: 0, values: {} }));
	expect(await loadWorkspaceSettings()).toEqual({ revision: 0, values: {} });
});

it("does not hydrate a late response from a previous workspace or account", async () => {
	let resolve!: (value: unknown) => void;
	const pending = new Promise((done) => {
		resolve = done;
	});
	mocks.read.mockReturnValue(Effect.promise(() => pending));
	const request = loadWorkspaceSettings();
	await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(1));
	selectRendererWorkspace({ kind: "organization", organizationId: "org_b" });
	resolve({ revision: 1, values: { branchNamingPrefix: "private-a" } });
	await expect(request).rejects.toThrow("workspace changed");
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
	mocks.read.mockReturnValue(Effect.succeed({ revision: 2, values: {} }));
	await loadWorkspaceSettings();
	observeRendererAccount("bob");
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
});

it("serializes local edits using the preceding committed revision", async () => {
	await Promise.all([
		updateWorkspaceSettings(() => ({ branchNamingPrefix: "team" })),
		updateWorkspaceSettings(() => ({ defaultAutoCreateWorktree: false })),
	]);
	expect(mocks.write.mock.calls.map(([input]) => input)).toEqual([
		{ expectedRevision: 1, values: { branchNamingPrefix: "team" } },
		{
			expectedRevision: 2,
			values: { branchNamingPrefix: "team", defaultAutoCreateWorktree: false },
		},
	]);
	expect(useWorkspaceSettingsState.getState().data?.revision).toBe(3);
});

it("does not retry a conflicting write or change the acknowledged value", async () => {
	await loadWorkspaceSettings();
	mocks.write.mockReturnValue(Effect.fail(new Error("conflict")));
	await expect(
		updateWorkspaceSettings(() => ({ branchNamingPrefix: "attempt" })),
	).rejects.toThrow("conflict");
	expect(mocks.write).toHaveBeenCalledTimes(1);
	expect(useWorkspaceSettingsState.getState()).toMatchObject({
		data: { revision: 1, values: { branchNamingPrefix: "a" } },
		error: expect.any(String),
	});
});

it("drops queued writes when the workspace changes before dispatch", async () => {
	const request = updateWorkspaceSettings(() => ({
		branchNamingPrefix: "stale",
	}));
	selectRendererWorkspace({ kind: "organization", organizationId: "org_b" });
	await expect(request).rejects.toThrow("workspace changed");
	expect(mocks.write).not.toHaveBeenCalled();
});

it("does not replace a committed edit with an older refresh response", async () => {
	await loadWorkspaceSettings();
	let commit!: (value: unknown) => void;
	mocks.write.mockReturnValueOnce(
		Effect.promise(
			() =>
				new Promise((done) => {
					commit = done;
				}),
		),
	);
	const write = updateWorkspaceSettings(() => ({ branchNamingPrefix: "new" }));
	await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
	let resolve!: (value: unknown) => void;
	const delayed = new Promise((done) => {
		resolve = done;
	});
	mocks.read.mockReturnValueOnce(Effect.promise(() => delayed));
	const refresh = loadWorkspaceSettings(true);
	await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledTimes(2));
	commit({ revision: 2, values: { branchNamingPrefix: "new" } });
	await write;
	resolve({ revision: 1, values: { branchNamingPrefix: "old" } });
	expect(await refresh).toMatchObject({
		revision: 2,
		values: { branchNamingPrefix: "new" },
	});
	expect(useWorkspaceSettingsState.getState().data).toEqual({
		revision: 2,
		values: { branchNamingPrefix: "new" },
	});
});

it("shares one refresh loop and stops it when the last selector releases", async () => {
	vi.useFakeTimers();
	vi.stubGlobal("window", {
		setInterval,
		clearInterval,
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	});
	vi.stubGlobal("document", {
		visibilityState: "visible",
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
	});
	const releaseFirst = retainWorkspaceSettings();
	const releaseSecond = retainWorkspaceSettings();
	try {
		await loadWorkspaceSettings();
		expect(mocks.read).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.read).toHaveBeenCalledTimes(2);
		releaseFirst();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.read).toHaveBeenCalledTimes(3);
		releaseSecond();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(mocks.read).toHaveBeenCalledTimes(3);
		expect(window.removeEventListener).toHaveBeenCalledOnce();
	} finally {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	}
});

it("clears revoked access and rejects an older successful write response", async () => {
	await loadWorkspaceSettings();
	let commit!: (value: unknown) => void;
	mocks.write.mockReturnValueOnce(
		Effect.promise(
			() =>
				new Promise((done) => {
					commit = done;
				}),
		),
	);
	const write = updateWorkspaceSettings(() => ({ branchNamingPrefix: "late" }));
	await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
	mocks.read.mockReturnValueOnce(
		Effect.fail(new CloudWorkspaceOpError({ code: "not-allowed" })),
	);
	await expect(loadWorkspaceSettings(true)).rejects.toMatchObject({
		code: "not-allowed",
	});
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
	commit({ revision: 2, values: { branchNamingPrefix: "late" } });
	await expect(write).rejects.toThrow("access changed");
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
});

it("shows an organization's cached settings at once when switching back, then revalidates", async () => {
	await loadWorkspaceSettings();
	selectRendererWorkspace({ kind: "organization", organizationId: "org_b" });
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	expect(useWorkspaceSettingsState.getState()).toMatchObject({
		data: { revision: 1, values: { branchNamingPrefix: "a" } },
		origin: "cache",
	});
	// Cached settings are display-only; readers still get a live copy.
	mocks.read.mockReturnValue(
		Effect.succeed({ revision: 2, values: { branchNamingPrefix: "a2" } }),
	);
	expect(await loadWorkspaceSettings()).toEqual({
		revision: 2,
		values: { branchNamingPrefix: "a2" },
	});
	expect(useWorkspaceSettingsState.getState().origin).toBe("runtime");
});

it("never shows another account's cached organization settings", async () => {
	await loadWorkspaceSettings();
	observeRendererAccount("bob");
	selectRendererWorkspace({ kind: "organization", organizationId: "org_a" });
	expect(useWorkspaceSettingsState.getState().data).toBeNull();
});
