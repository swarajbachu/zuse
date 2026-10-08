import {
	CloudSnapshotImportRequest,
	SnapshotAgentAccess,
	SnapshotGithubAccess,
	WIRE_PROTOCOL_VERSION,
} from "@zuse/contracts";
import type { SandboxProviderAdapter } from "@zuse/sandbox-providers";
import { Effect, Schema } from "effect";
import INSPECT_SOURCE from "../../cloud-sandboxes/snapshot-inspect.sh";
import { observeCloudRuntimeUsage } from "./cloud-usage.ts";
import {
	type CloudProjectBuildRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { randomToken, sha256Hex } from "./crypto.ts";

export const importedSnapshot = (
	build: CloudProjectBuildRecord | null | undefined,
) => build?.settings?.source === "custom-snapshot";

export const snapshotSettings = (build: CloudProjectBuildRecord) =>
	Schema.decodeUnknownSync(CloudSnapshotImportRequest)(
		build.settings?.snapshot,
	);

/** Imported sources follow their pinned credential version, independently of managed image releases. */
export const snapshotBuildCompatible = (
	build: CloudProjectBuildRecord,
	templateVersion: string | undefined,
) =>
	importedSnapshot(build)
		? typeof build.settings?.providerConnectionId === "string" &&
			templateVersion?.endsWith(
				`:connection:${build.settings.providerConnectionId}`,
			) === true
		: build.templateVersion === templateVersion;

export const snapshotRepositoryLayout = (
	build: CloudProjectBuildRecord,
	projectId: string,
) => {
	const rows = build.settings?.repositories;
	if (!Array.isArray(rows)) return undefined;
	const repository = rows.find(
		(row) =>
			typeof row === "object" && row !== null && row.projectId === projectId,
	);
	const path = repository?.path;
	const home = build.settings?.runtimeHome;
	if (
		typeof path !== "string" ||
		!path.startsWith("/") ||
		/[\0\r\n]/u.test(path) ||
		typeof home !== "string" ||
		!home.startsWith("/") ||
		/[\0\r\n]/u.test(home)
	)
		return undefined;
	return {
		runtimeUser: snapshotSettings(build).runtimeUser,
		runtimeHome: home,
		workspacePath: path,
		snapshotRevision: build.buildId,
		snapshotGitAuthentication:
			snapshotSettings(build).gitAuthentication ?? "native",
	};
};

/** Login status recorded by the last inspection; malformed rows are dropped. */
export const snapshotLogins = (build: CloudProjectBuildRecord) => {
	const checkedAt = build.updatedAtMs;
	const agents = (
		Array.isArray(build.settings?.nativeAgents)
			? build.settings.nativeAgents
			: []
	).flatMap((row) => {
		const decoded = Schema.decodeUnknownOption(
			SnapshotAgentAccess.mapFields((fields) => ({
				...fields,
				checkedAt: Schema.optional(Schema.Number),
			})),
		)(row);
		return decoded._tag === "Some"
			? [
					{
						providerId: decoded.value.providerId,
						state: decoded.value.state,
						...(decoded.value.account === undefined
							? {}
							: { account: decoded.value.account.slice(0, 120) }),
						checkedAt,
					},
				]
			: [];
	});
	const github = Schema.decodeUnknownOption(
		SnapshotGithubAccess.mapFields((fields) => ({
			...fields,
			checkedAt: Schema.optional(Schema.Number),
		})),
	)(build.settings?.nativeGithub);
	return {
		...(agents.length > 0 ? { agents } : {}),
		...(github._tag === "Some"
			? {
					github: {
						state: github.value.state,
						...(github.value.login !== undefined &&
						/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u.test(github.value.login)
							? { login: github.value.login }
							: {}),
						checkedAt,
					},
				}
			: {}),
	};
};

const Inspection = Schema.Struct({
	error: Schema.optional(Schema.String),
	runtimeHome: Schema.optional(
		Schema.String.check(Schema.isPattern(/^\/[^\0\r\n]*$/u)),
	),
	wireProtocolVersion: Schema.optional(Schema.Number),
	truncated: Schema.Boolean,
	agents: Schema.Array(
		Schema.Struct({
			providerId: Schema.String,
			state: Schema.String,
			account: Schema.optional(Schema.String),
		}),
	),
	github: Schema.optional(
		Schema.Struct({
			state: Schema.String,
			login: Schema.optional(Schema.String),
		}),
	),
	repositories: Schema.Array(
		Schema.Struct({
			path: Schema.String.check(Schema.isPattern(/^\/[^\0\r\n]*$/u)),
			identity: Schema.String.check(
				Schema.isPattern(/^github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
			),
			url: Schema.String,
			defaultBranch: Schema.String,
			sourceCommit: Schema.String,
			gitAccess: Schema.Literals([
				"readable",
				"authentication-required",
				"unavailable",
			]),
		}),
	),
});

/** An explicitly requested inspection uses a durable build record for recovery and usage. */
export const reconcileSnapshotImport = Effect.fn("reconcileSnapshotImport")(
	function* (
		build: CloudProjectBuildRecord,
		provider: SandboxProviderAdapter,
		nowMs: number,
	) {
		const store = yield* CloudWorkspaceStore;
		const settings = snapshotSettings(build);
		const resultFile = `/var/lib/zuse/project-build/${build.buildId}.json`;
		const scriptFile = `/var/lib/zuse/project-build/${build.buildId}.sh`;
		const fail = (code: string) =>
			store.saveBuild({
				...build,
				state: "failed",
				lastErrorCode: code,
				nextActionAtMs: Number.MAX_SAFE_INTEGER,
				revision: build.revision + 1,
				updatedAtMs: nowMs,
			});
		const cleanup = Effect.fn("cleanupSnapshotInspection")(function* () {
			if (!build.providerSandboxId) return;
			if ((yield* provider.inspect(build.providerSandboxId)) !== null)
				yield* provider.kill(build.providerSandboxId);
			yield* observeCloudRuntimeUsage({
				accountId: build.accountId,
				resourceKind: "build",
				resourceId: build.buildId,
				provider: build.provider,
				providerSandboxId: build.providerSandboxId,
				observedAtMs: nowMs,
				...provider.resources,
			});
		});
		const validateRuntimeUser = Effect.fn("validateSnapshotRuntimeUser")(
			function* () {
				if (!build.providerSandboxId) return false;
				const manifest = yield* Schema.decodeUnknownEffect(
					Schema.fromJsonString(
						Schema.Struct({
							schemaVersion: Schema.Literals([1]),
							runtimeUser: Schema.String,
						}),
					),
				)(
					yield* provider.readTextFile(
						build.providerSandboxId,
						"/etc/zuse/snapshot.json",
					),
				).pipe(Effect.result);
				if (
					manifest._tag === "Failure" ||
					manifest.success.runtimeUser !== settings.runtimeUser
				) {
					yield* cleanup();
					yield* fail(
						manifest._tag === "Failure"
							? "snapshot-installer-required"
							: "snapshot-runtime-user-mismatch",
					);
					return false;
				}
				return true;
			},
		);
		if (nowMs - build.createdAtMs > 10 * 60_000) {
			yield* cleanup();
			return yield* fail("snapshot-inspection-timeout");
		}
		if (build.state === "queued") {
			const earlier = (yield* store.listAccountBuilds(
				build.accountId,
				build.provider,
			)).some(
				(candidate) =>
					candidate.buildId !== build.buildId &&
					(candidate.createdAtMs < build.createdAtMs ||
						(candidate.createdAtMs === build.createdAtMs &&
							candidate.buildId < build.buildId)) &&
					(candidate.state === "queued" ||
						candidate.state === "building" ||
						candidate.state === "sanitizing"),
			);
			if (earlier)
				return yield* store.saveBuild({
					...build,
					nextActionAtMs: nowMs + 5_000,
					revision: build.revision + 1,
				});
			const label =
				`zuse-cloud-build-${build.buildId.replace(/[^A-Za-z0-9-]/gu, "-")}`.slice(
					0,
					63,
				);
			const sandbox =
				(yield* provider.recoverByLabel(label)) ??
				(yield* provider.fork({
					sandboxId: build.buildId,
					providerLabel: label,
					snapshotId: settings.snapshotId,
					snapshotSource: "custom-snapshot",
					snapshotVersion:
						typeof build.settings?.snapshotVersion === "number"
							? build.settings.snapshotVersion
							: undefined,
					metadata: {
						"zuse-account-id": build.accountId,
						"zuse-resource-kind": "build",
						"zuse-build-id": build.buildId,
					},
					timeoutSeconds: 600,
					env: {},
					network: { kind: "open" },
					onTimeout: "terminate",
				}));
			// Record allocation before launching commands; retries recover this same machine.
			build = { ...build, providerSandboxId: sandbox.providerSandboxId };
			yield* store.saveBuild({
				...build,
				revision: build.revision + 1,
				nextActionAtMs: nowMs + 5_000,
			});
			for (const prerequisite of [
				"/etc/zuse/snapshot.env",
				"/opt/zuse/node/bin/node",
				"/opt/zuse/current/bin.mjs",
			]) {
				if (
					!(yield* provider.pathExists(sandbox.providerSandboxId, prerequisite))
				) {
					yield* cleanup();
					return yield* fail("snapshot-installer-required");
				}
			}
			if (!(yield* validateRuntimeUser())) return;
			yield* provider.writeTextFile(
				sandbox.providerSandboxId,
				scriptFile,
				INSPECT_SOURCE,
				settings.runtimeUser,
			);
			yield* provider.replaceProcess(
				sandbox.providerSandboxId,
				{ tag: "snapshot-inspection" },
				{
					command: "/bin/bash",
					args: [
						"-lc",
						`source /etc/zuse/snapshot.env; exec bash ${scriptFile}`,
					],
					user: settings.runtimeUser,
					tag: "snapshot-inspection",
					cwd: "/",
					env: {
						ZUSE_SNAPSHOT_RESULT: resultFile,
						ZUSE_SNAPSHOT_PATHS: JSON.stringify(settings.repositoryPaths),
					},
				},
			);
			return yield* store.saveBuild({
				...build,
				state: "building",
				revision: build.revision + 2,
				nextActionAtMs: nowMs + 5_000,
				updatedAtMs: nowMs,
			});
		}
		if (!build.providerSandboxId)
			return yield* fail("snapshot-inspection-machine-missing");
		if (
			build.settings?.inspectionResult === undefined &&
			!(yield* validateRuntimeUser())
		)
			return;
		if (
			build.settings?.inspectionResult === undefined &&
			!(yield* provider.pathExists(build.providerSandboxId, resultFile))
		) {
			yield* store.saveBuild({
				...build,
				nextActionAtMs: nowMs + 5_000,
				revision: build.revision + 1,
			});
			return;
		}
		const decoded = yield* (
			build.settings?.inspectionResult === undefined
				? Schema.decodeUnknownEffect(Schema.fromJsonString(Inspection))(
						yield* provider.readTextFile(build.providerSandboxId, resultFile),
					)
				: Schema.decodeUnknownEffect(Inspection)(
						build.settings.inspectionResult,
					)
		).pipe(Effect.result);
		if (decoded._tag === "Failure") {
			yield* cleanup();
			return yield* fail("snapshot-inspection-invalid-result");
		}
		const result = decoded.success;
		if (build.settings?.inspectionResult === undefined) {
			build = {
				...build,
				state: "sanitizing",
				settings: { ...build.settings, inspectionResult: result },
				revision: build.revision + 1,
				nextActionAtMs: nowMs + 5_000,
			};
			yield* store.saveBuild(build);
		}
		if (
			result.error ||
			!result.runtimeHome ||
			result.wireProtocolVersion !== WIRE_PROTOCOL_VERSION ||
			result.repositories.length === 0
		) {
			yield* cleanup();
			return yield* fail(
				result.error ??
					(result.repositories.length === 0
						? "snapshot-no-repositories-add-paths"
						: "snapshot-runtime-update-required"),
			);
		}
		const repositories = [];
		const existing = yield* store.listProjects(build.accountId);
		for (const repository of result.repositories) {
			const project =
				existing.find(
					(candidate) => candidate.repositoryIdentity === repository.identity,
				) ??
				(yield* store.connectProject({
					projectId: yield* randomToken("project", 12),
					accountId: build.accountId,
					repositoryIdentity: repository.identity,
					repositoryUrl: repository.url,
					displayName: repository.identity.split("/").slice(1).join("/"),
					defaultBranch: repository.defaultBranch,
					visibility: "private",
					gitConnectionKind: "github-app",
					cloudEnvironment: {},
					secretBindings: [],
					configurationDigest: yield* sha256Hex(repository.identity),
					state: "ready",
					idempotencyKey: `snapshot:${repository.identity}`,
					createdAtMs: nowMs,
					updatedAtMs: nowMs,
				}));
			yield* store.saveProject({
				...project,
				state: "ready",
				updatedAtMs: nowMs,
			});
			repositories.push({
				projectId: project.projectId,
				repositoryIdentity: project.repositoryIdentity,
				displayName: project.displayName,
				...repository,
			});
		}
		// Keep a completed inspection until cleanup succeeds; never touch the source snapshot.
		yield* cleanup();
		yield* store.saveBuild({
			...build,
			state: "ready",
			snapshotId: settings.snapshotId,
			providerSandboxId: undefined,
			settings: {
				...build.settings,
				runtimeHome: result.runtimeHome,
				repositories,
				nativeAgents: result.agents,
				nativeGithub: result.github,
				discoveryTruncated: result.truncated,
			},
			logText: result.truncated
				? "Discovery reached its limit. Add explicit repository paths to inspect other locations."
				: "Snapshot inspected. Repositories, GitHub and agent logins were checked.",
			nextActionAtMs: Number.MAX_SAFE_INTEGER,
			revision: build.revision + 1,
			updatedAtMs: nowMs,
		});
	},
);
