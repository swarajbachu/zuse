import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { SandboxProviders } from "@zuse/sandbox-providers";
import { SandboxProvidersFake } from "@zuse/sandbox-providers/testing";
import { Effect, Layer, Redacted } from "effect";
import { describe, expect, test, vi } from "vitest";
import { CloudBillingStoreMemory } from "../../src/cloud-billing-store-memory.ts";
import {
	reconcileSnapshotImport,
	snapshotBuildCompatible,
	snapshotRepositoryLayout,
} from "../../src/cloud-snapshot.ts";
import {
	cloudWorkspaceLayout,
	cloudWorkspaceRepositoryPath,
} from "../../src/cloud-workspace-paths.ts";
import {
	type CloudProjectBuildRecord,
	CloudWorkspaceStore,
	CloudWorkspaceStoreMemory,
} from "../../src/cloud-workspace-store.ts";
import { layer as configLayer } from "../../src/config.ts";

const build = (
	overrides: Partial<CloudProjectBuildRecord> = {},
): CloudProjectBuildRecord => ({
	buildId: "image_snapshot",
	projectId: null,
	accountId: "account",
	provider: "fake",
	templateVersion: "old:connection:key-one",
	configurationDigest: "digest",
	settings: {
		source: "custom-snapshot",
		providerConnectionId: "key-one",
		snapshot: {
			connectionId: "key-one",
			snapshotId: "external-snapshot",
			runtimeUser: "developer",
			repositoryPaths: [],
			idempotencyKey: "request",
		},
	},
	state: "queued",
	idempotencyKey: "request",
	nextActionAtMs: 0,
	revision: 0,
	createdAtMs: 0,
	updatedAtMs: 0,
	...overrides,
});
const layer = Layer.mergeAll(
	CloudWorkspaceStoreMemory,
	CloudBillingStoreMemory,
	SandboxProvidersFake,
	configLayer({
		apiIssuer: "https://api.test",
		workosJwksUrl: "https://unused.test",
		workosIssuer: "https://unused.test",
		mintPrivateKey: Redacted.make("{}"),
		mintPublicKey: "{}",
	}),
);
const inspected = {
	runtimeHome: "/home/developer",
	wireProtocolVersion: WIRE_PROTOCOL_VERSION,
	truncated: false,
	agents: [{ providerId: "codex", state: "detected" }],
	repositories: [
		{
			path: "/srv/Project with spaces",
			identity: "github.com/acme/repo",
			url: "https://github.com/acme/repo.git",
			defaultBranch: "main",
			sourceCommit: "abc123",
			gitAccess: "readable",
		},
	],
};

describe("custom snapshot import", () => {
	test("survives managed runtime upgrades but never crosses provider connections", () => {
		expect(snapshotBuildCompatible(build(), "new:connection:key-one")).toBe(
			true,
		);
		expect(snapshotBuildCompatible(build(), "new:connection:key-two")).toBe(
			false,
		);
		expect(snapshotBuildCompatible(build(), undefined)).toBe(false);
	});
	test("pins arbitrary repository paths and derives separate SSH state", () => {
		const source = build();
		const layout = snapshotRepositoryLayout(
			{
				...source,
				settings: {
					...source.settings,
					runtimeHome: "/home/developer",
					repositories: [{ projectId: "p", path: "/srv/Project with spaces" }],
				},
			},
			"p",
		);
		expect(layout?.runtimeUser).toBe("developer");
		const workspace = { requestConfig: layout ?? {} };
		expect(
			cloudWorkspaceRepositoryPath(workspace, "github.com/acme/repo"),
		).toBe("/srv/Project with spaces");
		expect(cloudWorkspaceLayout(workspace).sshDirectory).toBe(
			"/var/lib/zuse/ssh",
		);
		expect(snapshotRepositoryLayout(source, "missing")).toBeUndefined();
		expect(() =>
			cloudWorkspaceLayout({ requestConfig: { snapshotRevision: "x" } }),
		).toThrow();
	});
	test("imports repositories without building or deleting the external snapshot", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const base = yield* (yield* SandboxProviders).get("fake");
				const fork = vi.fn(base.fork);
				const snapshot = vi.fn(base.snapshot);
				const remove = vi.fn(base.deleteSnapshot);
				const provider = {
					...base,
					fork,
					snapshot,
					deleteSnapshot: remove,
					pathExists: () => Effect.succeed(true),
					readTextFile: () => Effect.succeed(JSON.stringify(inspected)),
				};
				yield* store.createBuild(build());
				yield* reconcileSnapshotImport(build(), provider, 1);
				const allocated = yield* store.getBuild("image_snapshot");
				if (!allocated) throw new Error("allocation missing");
				expect(allocated.state).toBe("building");
				yield* reconcileSnapshotImport(allocated, provider, 2);
				const ready = yield* store.getBuild("image_snapshot");
				expect(ready?.state).toBe("ready");
				expect(ready?.snapshotId).toBe("external-snapshot");
				expect(ready?.providerSandboxId).toBeUndefined();
				expect(fork).toHaveBeenCalledOnce();
				expect(snapshot).not.toHaveBeenCalled();
				expect(remove).not.toHaveBeenCalled();
				const projects = yield* store.listProjects("account");
				expect(projects).toHaveLength(1);
				if (!ready || !projects[0]) throw new Error("Missing imported project");
				expect(
					snapshotRepositoryLayout(ready, projects[0].projectId)?.workspacePath,
				).toBe("/srv/Project with spaces");
			}).pipe(Effect.provide(layer)),
		);
	});
	test("recovers a persisted inspection after the disposable machine is already gone", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const provider = yield* (yield* SandboxProviders).get("fake");
				const input = build({
					state: "sanitizing",
					providerSandboxId: "already-deleted",
					settings: { ...build().settings, inspectionResult: inspected },
				});
				yield* store.createBuild(input);
				yield* reconcileSnapshotImport(input, provider, 2);
				expect((yield* store.getBuild(input.buildId))?.state).toBe("ready");
			}).pipe(Effect.provide(layer)),
		);
	});
	test("missing installer fails promptly and cleans up only its disposable machine", async () => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* CloudWorkspaceStore;
				const base = yield* (yield* SandboxProviders).get("fake");
				const kill = vi.fn(base.kill);
				yield* store.createBuild(build());
				yield* reconcileSnapshotImport(
					build(),
					{ ...base, kill, pathExists: () => Effect.succeed(false) },
					1,
				);
				expect((yield* store.getBuild("image_snapshot"))?.lastErrorCode).toBe(
					"snapshot-installer-required",
				);
				expect(kill).toHaveBeenCalledOnce();
				expect(kill.mock.calls[0]?.[0]).not.toBe("external-snapshot");
			}).pipe(Effect.provide(layer)),
		);
	});
});
