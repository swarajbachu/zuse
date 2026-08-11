import type {
	CloudCredentialKind,
	CloudProjectBuildState,
	CloudProjectState,
	CloudWorkspaceDesiredState,
	CloudWorkspaceState,
} from "@zuse/contracts";
import { Context, Effect, Layer, Ref } from "effect";
import { SqlClient } from "effect/unstable/sql";

export interface CloudProjectRecord {
	readonly projectId: string;
	readonly accountId: string;
	readonly repositoryIdentity: string;
	readonly repositoryUrl: string;
	readonly displayName: string;
	readonly defaultBranch: string;
	readonly visibility: "public" | "private";
	readonly gitConnectionKind: "github-app";
	readonly cloudEnvironment: Readonly<Record<string, string>>;
	readonly secretBindings: ReadonlyArray<string>;
	readonly configurationDigest: string;
	readonly state: CloudProjectState;
	readonly lastErrorCode?: string;
	readonly idempotencyKey: string;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudProjectBuildRecord {
	readonly buildId: string;
	readonly projectId: string;
	readonly accountId: string;
	readonly provider: string;
	readonly providerSandboxId?: string;
	readonly snapshotId?: string;
	readonly sourceCommit?: string;
	readonly templateVersion: string;
	readonly configurationDigest: string;
	readonly state: CloudProjectBuildState;
	readonly lastErrorCode?: string;
	readonly idempotencyKey: string;
	readonly nextActionAtMs: number;
	readonly leaseOwner?: string;
	readonly leaseExpiresAtMs?: number;
	readonly revision: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
}

export interface CloudWorkspaceRecord {
	readonly workspaceId: string;
	readonly accountId: string;
	readonly projectId: string;
	readonly buildId: string;
	readonly provider: string;
	readonly providerSandboxId?: string;
	readonly runtimeBootTokenHash?: string;
	readonly runtimeBootTokenExpiresAtMs?: number;
	readonly runtimeCredentialHash?: string;
	readonly runtimeState: "offline" | "connecting" | "online";
	readonly chatId: string;
	readonly initialSessionId: string;
	readonly branch: string;
	readonly baseRef: string;
	readonly state: CloudWorkspaceState;
	readonly desiredState: CloudWorkspaceDesiredState;
	readonly statusCode: string;
	readonly credentialEpoch: number;
	readonly recoveryBundleKey?: string;
	readonly warmRetentionDeadlineMs?: number;
	readonly idempotencyKey: string;
	readonly requestConfig: Readonly<Record<string, unknown>>;
	readonly nextActionAtMs: number;
	readonly leaseOwner?: string;
	readonly leaseExpiresAtMs?: number;
	readonly revision: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly lastActivityAtMs: number;
	readonly runningSinceMs?: number;
	readonly deletedAtMs?: number;
}

export interface CloudWorkspaceCommandRecord {
	readonly commandId: string;
	readonly workspaceId: string;
	readonly accountId: string;
	readonly sequence: number;
	readonly kind: "start-agent";
	readonly payload: Readonly<Record<string, unknown>>;
	readonly state: "queued" | "claimed" | "acknowledged" | "failed";
	readonly createdAtMs: number;
	readonly claimedAtMs?: number;
	readonly acknowledgedAtMs?: number;
	readonly failedAtMs?: number;
}

export interface CloudWorkspaceEventRecord {
	readonly workspaceId: string;
	readonly runtimeSequence: number;
	readonly eventId: string;
	readonly streamId: string;
	readonly streamVersion: number;
	readonly type: string;
	readonly payloadJson: string;
	readonly createdAtMs: number;
}

export interface CloudCredentialRecord {
	readonly connectionId: string;
	readonly accountId: string;
	readonly kind: CloudCredentialKind;
	readonly state: "connected" | "disconnected" | "error";
	readonly accountLabel?: string;
	readonly encryptedPayload?: string;
	readonly encryptionKeyVersion?: string;
	readonly credentialVersion: number;
	readonly createdAtMs: number;
	readonly updatedAtMs: number;
	readonly disconnectedAtMs?: number;
}

export type CreateCloudWorkspaceOutcome =
	| {
			readonly kind: "created" | "existing";
			readonly workspace: CloudWorkspaceRecord;
	  }
	| {
			readonly kind: "branch-in-use";
			readonly workspace: CloudWorkspaceRecord;
	  };

export interface CloudWorkspaceStoreApi {
	readonly connectProject: (
		project: CloudProjectRecord,
	) => Effect.Effect<CloudProjectRecord>;
	readonly listProjects: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<CloudProjectRecord>>;
	readonly getProject: (
		projectId: string,
	) => Effect.Effect<CloudProjectRecord | null>;
	readonly saveProject: (project: CloudProjectRecord) => Effect.Effect<void>;
	readonly createBuild: (
		build: CloudProjectBuildRecord,
	) => Effect.Effect<CloudProjectBuildRecord>;
	readonly getActiveBuild: (
		projectId: string,
		provider: string,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly getBuild: (
		buildId: string,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly claimBuild: (
		buildId: string,
		leaseOwner: string,
		nowMs: number,
		leaseExpiresAtMs: number,
	) => Effect.Effect<CloudProjectBuildRecord | null>;
	readonly listBuilds: (
		projectId: string,
	) => Effect.Effect<ReadonlyArray<CloudProjectBuildRecord>>;
	readonly saveBuild: (build: CloudProjectBuildRecord) => Effect.Effect<void>;
	readonly listDueBuilds: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudProjectBuildRecord>>;
	readonly createWorkspace: (
		workspace: CloudWorkspaceRecord,
		command: CloudWorkspaceCommandRecord,
	) => Effect.Effect<CreateCloudWorkspaceOutcome>;
	readonly listWorkspaces: (
		accountId: string,
		projectId?: string,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceRecord>>;
	readonly getWorkspace: (
		workspaceId: string,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly claimWorkspace: (
		workspaceId: string,
		leaseOwner: string,
		nowMs: number,
		leaseExpiresAtMs: number,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly saveWorkspace: (
		workspace: CloudWorkspaceRecord,
	) => Effect.Effect<void>;
	readonly consumeRuntimeBoot: (input: {
		readonly workspaceId: string;
		readonly bootTokenHash: string;
		readonly runtimeCredentialHash: string;
		readonly runtimeCredentialExpiresAtMs: number;
		readonly nowMs: number;
	}) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly listDueWorkspaces: (
		nowMs: number,
		limit: number,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceRecord>>;
	readonly recordActivity: (
		workspaceId: string,
		accountId: string,
		nowMs: number,
		nextIdleAtMs: number,
	) => Effect.Effect<CloudWorkspaceRecord | null>;
	readonly createConnectionGrant: (input: {
		readonly grantHash: string;
		readonly workspaceId: string;
		readonly accountId: string;
		readonly expiresAtMs: number;
		readonly createdAtMs: number;
	}) => Effect.Effect<void>;
	readonly consumeConnectionGrant: (
		grantHash: string,
		workspaceId: string,
		nowMs: number,
	) => Effect.Effect<boolean>;
	readonly createCommand: (
		command: CloudWorkspaceCommandRecord,
	) => Effect.Effect<CloudWorkspaceCommandRecord>;
	readonly listCommands: (
		workspaceId: string,
		afterSequence: number,
		nowMs: number,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceCommandRecord>>;
	readonly acknowledgeCommand: (
		workspaceId: string,
		commandId: string,
		nowMs: number,
	) => Effect.Effect<boolean>;
	readonly appendEvents: (
		workspaceId: string,
		events: ReadonlyArray<CloudWorkspaceEventRecord>,
	) => Effect.Effect<number>;
	readonly listEvents: (
		workspaceId: string,
		afterSequence: number,
	) => Effect.Effect<ReadonlyArray<CloudWorkspaceEventRecord>>;
	readonly listCredentials: (
		accountId: string,
	) => Effect.Effect<ReadonlyArray<CloudCredentialRecord>>;
	readonly getCredential: (
		accountId: string,
		kind: CloudCredentialKind,
	) => Effect.Effect<CloudCredentialRecord | null>;
	readonly saveCredential: (
		credential: CloudCredentialRecord,
	) => Effect.Effect<CloudCredentialRecord>;
	readonly disconnectCredential: (
		accountId: string,
		kind: CloudCredentialKind,
		nowMs: number,
	) => Effect.Effect<CloudCredentialRecord | null>;
	readonly credentialEpoch: (accountId: string) => Effect.Effect<number>;
	readonly deleteAccountData: (accountId: string) => Effect.Effect<void>;
	readonly recordUsage: (event: {
		readonly eventId: string;
		readonly workspaceId: string;
		readonly accountId: string;
		readonly provider: string;
		readonly kind: string;
		readonly quantity: number;
		readonly providerEventId?: string;
		readonly occurredAtMs: number;
	}) => Effect.Effect<boolean>;
}

export class CloudWorkspaceStore extends Context.Service<
	CloudWorkspaceStore,
	CloudWorkspaceStoreApi
>()("@zuse/relay/CloudWorkspaceStore") {}

interface MemoryState {
	readonly projects: Map<string, CloudProjectRecord>;
	readonly builds: Map<string, CloudProjectBuildRecord>;
	readonly workspaces: Map<string, CloudWorkspaceRecord>;
	readonly credentials: Map<string, CloudCredentialRecord>;
	readonly usage: Set<string>;
	readonly connectionGrants: Map<
		string,
		{
			readonly workspaceId: string;
			readonly accountId: string;
			readonly expiresAtMs: number;
			readonly consumedAtMs?: number;
		}
	>;
	readonly commands: Map<string, CloudWorkspaceCommandRecord>;
	readonly events: Map<string, CloudWorkspaceEventRecord>;
}

const activeBranch = (workspace: CloudWorkspaceRecord): boolean =>
	workspace.state !== "deleted";

export const CloudWorkspaceStoreMemory = Layer.effect(
	CloudWorkspaceStore,
	Effect.gen(function* () {
		const state = yield* Ref.make<MemoryState>({
			projects: new Map(),
			builds: new Map(),
			workspaces: new Map(),
			credentials: new Map(),
			usage: new Set(),
			connectionGrants: new Map(),
			commands: new Map(),
			events: new Map(),
		});
		return CloudWorkspaceStore.of({
			connectProject: (project) =>
				Ref.modify(state, (current) => {
					const retry = [...current.projects.values()].find(
						(candidate) =>
							candidate.accountId === project.accountId &&
							candidate.idempotencyKey === project.idempotencyKey,
					);
					if (retry !== undefined) return [retry, current] as const;
					const existing = [...current.projects.values()].find(
						(candidate) =>
							candidate.accountId === project.accountId &&
							candidate.repositoryIdentity === project.repositoryIdentity,
					);
					if (existing !== undefined) {
						const updated = {
							...project,
							projectId: existing.projectId,
							createdAtMs: existing.createdAtMs,
						};
						return [
							updated,
							{
								...current,
								projects: new Map(current.projects).set(
									existing.projectId,
									updated,
								),
							},
						] as const;
					}
					const projects = new Map(current.projects);
					projects.set(project.projectId, project);
					return [project, { ...current, projects }] as const;
				}),
			listProjects: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.projects.values()].filter(
							(item) => item.accountId === accountId,
						),
					),
				),
			getProject: (projectId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.projects.get(projectId) ?? null),
				),
			saveProject: (project) =>
				Ref.update(state, (current) => ({
					...current,
					projects: new Map(current.projects).set(project.projectId, project),
				})),
			createBuild: (build) =>
				Ref.modify(state, (current) => {
					const existing = [...current.builds.values()].find(
						(candidate) =>
							candidate.projectId === build.projectId &&
							candidate.provider === build.provider &&
							candidate.idempotencyKey === build.idempotencyKey,
					);
					if (existing !== undefined) return [existing, current] as const;
					return [
						build,
						{
							...current,
							builds: new Map(current.builds).set(build.buildId, build),
						},
					] as const;
				}),
			getActiveBuild: (projectId, provider) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.builds.values()]
								.filter(
									(build) =>
										build.projectId === projectId &&
										build.provider === provider &&
										build.state === "ready",
								)
								.sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null,
					),
				),
			getBuild: (buildId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.builds.get(buildId) ?? null),
				),
			claimBuild: (buildId, leaseOwner, nowMs, leaseExpiresAtMs) =>
				Ref.modify(state, (current) => {
					const build = current.builds.get(buildId);
					if (
						build === undefined ||
						(build.leaseExpiresAtMs !== undefined &&
							build.leaseExpiresAtMs > nowMs)
					)
						return [null, current] as const;
					const claimed = { ...build, leaseOwner, leaseExpiresAtMs };
					return [
						claimed,
						{
							...current,
							builds: new Map(current.builds).set(buildId, claimed),
						},
					] as const;
				}),
			listBuilds: (projectId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.builds.values()].filter(
							(build) => build.projectId === projectId,
						),
					),
				),
			saveBuild: (build) =>
				Ref.update(state, (current) => ({
					...current,
					builds: new Map(current.builds).set(build.buildId, {
						...build,
						leaseOwner: undefined,
						leaseExpiresAtMs: undefined,
					}),
				})),
			listDueBuilds: (nowMs, limit) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.builds.values()]
							.filter(
								(build) =>
									build.state !== "ready" &&
									build.state !== "failed" &&
									build.nextActionAtMs <= nowMs,
							)
							.slice(0, limit),
					),
				),
			createWorkspace: (workspace, command) =>
				Ref.modify<MemoryState, CreateCloudWorkspaceOutcome>(
					state,
					(current) => {
						const existing = [...current.workspaces.values()].find(
							(candidate) =>
								candidate.accountId === workspace.accountId &&
								candidate.idempotencyKey === workspace.idempotencyKey,
						);
						if (existing !== undefined)
							return [
								{ kind: "existing", workspace: existing } as const,
								current,
							] as const;
						const conflict = [...current.workspaces.values()].find(
							(candidate) =>
								candidate.projectId === workspace.projectId &&
								candidate.branch === workspace.branch &&
								activeBranch(candidate),
						);
						if (conflict !== undefined)
							return [
								{ kind: "branch-in-use", workspace: conflict } as const,
								current,
							] as const;
						return [
							{ kind: "created", workspace } as const,
							{
								...current,
								workspaces: new Map(current.workspaces).set(
									workspace.workspaceId,
									workspace,
								),
								commands: new Map(current.commands).set(
									command.commandId,
									command,
								),
							},
						] as const;
					},
				),
			listWorkspaces: (accountId, projectId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.workspaces.values()].filter(
							(item) =>
								item.accountId === accountId &&
								(projectId === undefined || item.projectId === projectId),
						),
					),
				),
			getWorkspace: (workspaceId) =>
				Ref.get(state).pipe(
					Effect.map((current) => current.workspaces.get(workspaceId) ?? null),
				),
			claimWorkspace: (workspaceId, leaseOwner, nowMs, leaseExpiresAtMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (
						workspace === undefined ||
						(workspace.leaseExpiresAtMs !== undefined &&
							workspace.leaseExpiresAtMs > nowMs)
					)
						return [null, current] as const;
					const claimed = { ...workspace, leaseOwner, leaseExpiresAtMs };
					return [
						claimed,
						{
							...current,
							workspaces: new Map(current.workspaces).set(workspaceId, claimed),
						},
					] as const;
				}),
			consumeRuntimeBoot: (input) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(input.workspaceId);
					if (
						workspace === undefined ||
						workspace.runtimeBootTokenHash !== input.bootTokenHash ||
						(workspace.runtimeBootTokenExpiresAtMs ?? 0) <= input.nowMs ||
						workspace.desiredState !== "ready" ||
						workspace.providerSandboxId === undefined ||
						workspace.state === "deleted"
					)
						return [null, current] as const;
					const timings =
						(workspace.requestConfig.startupTimings as
							| Readonly<Record<string, number>>
							| undefined) ?? {};
					const updated: CloudWorkspaceRecord = {
						...workspace,
						runtimeBootTokenHash: undefined,
						runtimeBootTokenExpiresAtMs: undefined,
						runtimeCredentialHash: input.runtimeCredentialHash,
						runtimeState: "connecting",
						state: "setup",
						statusCode: "runtime-authenticating",
						requestConfig: {
							...workspace.requestConfig,
							runtimeCredentialExpiresAtMs: input.runtimeCredentialExpiresAtMs,
							startupTimings: {
								...timings,
								enrolledAt: input.nowMs,
								runtimeReadyAt: input.nowMs,
								enrollmentDurationMs:
									timings.allocatedAt === undefined
										? undefined
										: input.nowMs - timings.allocatedAt,
							},
						},
						nextActionAtMs: input.nowMs + 30_000,
						revision: workspace.revision + 1,
						updatedAtMs: input.nowMs,
					};
					return [
						updated,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								workspace.workspaceId,
								updated,
							),
						},
					] as const;
				}),
			saveWorkspace: (workspace) =>
				Ref.update(state, (current) => {
					const saved = current.workspaces.get(workspace.workspaceId);
					if (
						saved !== undefined &&
						(saved.revision > workspace.revision ||
							(saved.revision === workspace.revision &&
								saved.updatedAtMs > workspace.updatedAtMs))
					)
						return current;
					return {
						...current,
						workspaces: new Map(current.workspaces).set(workspace.workspaceId, {
							...workspace,
							leaseOwner: undefined,
							leaseExpiresAtMs: undefined,
						}),
					};
				}),
			listDueWorkspaces: (nowMs, limit) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.workspaces.values()]
							.filter(
								(workspace) =>
									workspace.state !== "deleted" &&
									workspace.nextActionAtMs <= nowMs,
							)
							.slice(0, limit),
					),
				),
			recordActivity: (workspaceId, accountId, nowMs, nextIdleAtMs) =>
				Ref.modify(state, (current) => {
					const workspace = current.workspaces.get(workspaceId);
					if (workspace?.accountId !== accountId)
						return [null, current] as const;
					const updated: CloudWorkspaceRecord = {
						...workspace,
						desiredState:
							workspace.state === "paused" ? "ready" : workspace.desiredState,
						statusCode:
							workspace.state === "paused"
								? "resume-queued"
								: workspace.statusCode,
						requestConfig:
							workspace.state === "paused"
								? {
										...workspace.requestConfig,
										startupTimings: {
											requestedAt: nowMs,
											resumeRequestedAt: nowMs,
										},
									}
								: workspace.requestConfig,
						nextActionAtMs: workspace.state === "paused" ? nowMs : nextIdleAtMs,
						lastActivityAtMs: nowMs,
						revision: workspace.revision + 1,
						updatedAtMs: nowMs,
					};
					return [
						updated,
						{
							...current,
							workspaces: new Map(current.workspaces).set(
								workspace.workspaceId,
								updated,
							),
						},
					] as const;
				}),
			createConnectionGrant: (input) =>
				Ref.update(state, (current) => ({
					...current,
					connectionGrants: new Map(current.connectionGrants).set(
						input.grantHash,
						{
							workspaceId: input.workspaceId,
							accountId: input.accountId,
							expiresAtMs: input.expiresAtMs,
						},
					),
				})),
			consumeConnectionGrant: (grantHash, workspaceId, nowMs) =>
				Ref.modify(state, (current) => {
					const grant = current.connectionGrants.get(grantHash);
					if (
						grant === undefined ||
						grant.workspaceId !== workspaceId ||
						grant.consumedAtMs !== undefined ||
						grant.expiresAtMs <= nowMs
					)
						return [false, current] as const;
					return [
						true,
						{
							...current,
							connectionGrants: new Map(current.connectionGrants).set(
								grantHash,
								{ ...grant, consumedAtMs: nowMs },
							),
						},
					] as const;
				}),
			createCommand: (command) =>
				Ref.modify(state, (current) => {
					const existing = current.commands.get(command.commandId);
					if (existing !== undefined) return [existing, current] as const;
					return [
						command,
						{
							...current,
							commands: new Map(current.commands).set(
								command.commandId,
								command,
							),
						},
					] as const;
				}),
			listCommands: (workspaceId, afterSequence, nowMs) =>
				Ref.modify(state, (current) => {
					const commands = [...current.commands.values()]
						.filter(
							(command) =>
								command.workspaceId === workspaceId &&
								command.sequence > afterSequence &&
								(command.state === "queued" || command.state === "claimed"),
						)
						.sort((a, b) => a.sequence - b.sequence)
						.map((command) => ({
							...command,
							state: "claimed" as const,
							claimedAtMs: command.claimedAtMs ?? nowMs,
						}));
					const updated = new Map(current.commands);
					for (const command of commands)
						updated.set(command.commandId, command);
					return [commands, { ...current, commands: updated }] as const;
				}),
			acknowledgeCommand: (workspaceId, commandId, nowMs) =>
				Ref.modify(state, (current) => {
					const command = current.commands.get(commandId);
					if (command?.workspaceId !== workspaceId)
						return [false, current] as const;
					const updated = {
						...command,
						state: "acknowledged" as const,
						acknowledgedAtMs: nowMs,
					};
					return [
						true,
						{
							...current,
							commands: new Map(current.commands).set(commandId, updated),
						},
					] as const;
				}),
			appendEvents: (workspaceId, events) =>
				Ref.modify(state, (current) => {
					const updated = new Map(current.events);
					let appended = 0;
					for (const event of events) {
						const key = `${workspaceId}:${event.runtimeSequence}`;
						if (updated.has(key)) continue;
						updated.set(key, event);
						appended += 1;
					}
					return [appended, { ...current, events: updated }] as const;
				}),
			listEvents: (workspaceId, afterSequence) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.events.values()]
							.filter(
								(event) =>
									event.workspaceId === workspaceId &&
									event.runtimeSequence > afterSequence,
							)
							.sort((a, b) => a.runtimeSequence - b.runtimeSequence),
					),
				),
			listCredentials: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.credentials.values()].filter(
							(item) => item.accountId === accountId,
						),
					),
				),
			getCredential: (accountId, kind) =>
				Ref.get(state).pipe(
					Effect.map(
						(current) =>
							[...current.credentials.values()].find(
								(item) => item.accountId === accountId && item.kind === kind,
							) ?? null,
					),
				),
			saveCredential: (credential) =>
				Ref.modify(state, (current) => {
					const key = `${credential.accountId}:${credential.kind}`;
					return [
						credential,
						{
							...current,
							credentials: new Map(current.credentials).set(key, credential),
						},
					] as const;
				}),
			disconnectCredential: (accountId, kind, nowMs) =>
				Ref.modify(state, (current) => {
					const key = `${accountId}:${kind}`;
					const existing = current.credentials.get(key);
					if (existing === undefined) return [null, current] as const;
					const updated: CloudCredentialRecord = {
						...existing,
						state: "disconnected",
						encryptedPayload: undefined,
						credentialVersion: existing.credentialVersion + 1,
						updatedAtMs: nowMs,
						disconnectedAtMs: nowMs,
					};
					return [
						updated,
						{
							...current,
							credentials: new Map(current.credentials).set(key, updated),
						},
					] as const;
				}),
			credentialEpoch: (accountId) =>
				Ref.get(state).pipe(
					Effect.map((current) =>
						[...current.credentials.values()]
							.filter(
								(item) =>
									item.accountId === accountId && item.state === "connected",
							)
							.reduce((sum, item) => sum + item.credentialVersion, 0),
					),
				),
			deleteAccountData: (accountId) =>
				Ref.update(state, (current) => {
					const projects = new Map(
						[...current.projects].filter(
							([, project]) => project.accountId !== accountId,
						),
					);
					const builds = new Map(
						[...current.builds].filter(
							([, item]) => item.accountId !== accountId,
						),
					);
					const workspaces = new Map(
						[...current.workspaces].filter(
							([, item]) => item.accountId !== accountId,
						),
					);
					const credentials = new Map(
						[...current.credentials].filter(
							([, item]) => item.accountId !== accountId,
						),
					);
					return { ...current, projects, builds, workspaces, credentials };
				}),
			recordUsage: (event) =>
				Ref.modify(state, (current) => {
					if (current.usage.has(event.eventId))
						return [false, current] as const;
					const usage = new Set(current.usage);
					usage.add(event.eventId);
					return [true, { ...current, usage }] as const;
				}),
		});
	}),
);

type Row = Record<string, unknown>;
const numberValue = (value: unknown): number =>
	typeof value === "number" ? value : Number(value);
const optionalNumber = (value: unknown): number | undefined =>
	value == null ? undefined : numberValue(value);
const optionalString = (value: unknown): string | undefined =>
	typeof value === "string" ? value : undefined;
const projectFromRow = (row: Row): CloudProjectRecord => ({
	projectId: String(row.project_id),
	accountId: String(row.account_id),
	repositoryIdentity: String(row.repository_identity),
	repositoryUrl: String(row.repository_url),
	displayName: String(row.display_name),
	defaultBranch: String(row.default_branch),
	visibility: row.visibility as "public" | "private",
	gitConnectionKind: "github-app",
	cloudEnvironment: (row.cloud_environment ?? {}) as Record<string, string>,
	secretBindings: (row.secret_bindings ?? []) as string[],
	configurationDigest: String(row.configuration_digest),
	state: row.state as CloudProjectState,
	lastErrorCode: optionalString(row.last_error_code),
	idempotencyKey: String(row.idempotency_key),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
});
const buildFromRow = (row: Row): CloudProjectBuildRecord => ({
	buildId: String(row.build_id),
	projectId: String(row.project_id),
	accountId: String(row.account_id),
	provider: String(row.provider),
	providerSandboxId: optionalString(row.provider_sandbox_id),
	snapshotId: optionalString(row.snapshot_id),
	sourceCommit: optionalString(row.source_commit),
	templateVersion: String(row.template_version),
	configurationDigest: String(row.configuration_digest),
	state: row.state as CloudProjectBuildState,
	lastErrorCode: optionalString(row.last_error_code),
	idempotencyKey: String(row.idempotency_key),
	nextActionAtMs: numberValue(row.next_action_at),
	leaseOwner: optionalString(row.lease_owner),
	leaseExpiresAtMs: optionalNumber(row.lease_expires_at),
	revision: numberValue(row.revision),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
});
const workspaceFromRow = (row: Row): CloudWorkspaceRecord => ({
	workspaceId: String(row.workspace_id),
	accountId: String(row.account_id),
	projectId: String(row.project_id),
	buildId: String(row.build_id),
	provider: String(row.provider),
	providerSandboxId: optionalString(row.provider_sandbox_id),
	runtimeBootTokenHash: optionalString(row.runtime_boot_token_hash),
	runtimeBootTokenExpiresAtMs: optionalNumber(
		row.runtime_boot_token_expires_at,
	),
	runtimeCredentialHash: optionalString(row.runtime_credential_hash),
	runtimeState: row.runtime_state as CloudWorkspaceRecord["runtimeState"],
	chatId: String(row.chat_id),
	initialSessionId: String(row.initial_session_id),
	branch: String(row.branch),
	baseRef: String(row.base_ref),
	state: row.state as CloudWorkspaceState,
	desiredState: row.desired_state as CloudWorkspaceDesiredState,
	statusCode: String(row.status_code),
	credentialEpoch: numberValue(row.credential_epoch),
	recoveryBundleKey: optionalString(row.recovery_bundle_key),
	warmRetentionDeadlineMs: optionalNumber(row.warm_retention_deadline),
	idempotencyKey: String(row.idempotency_key),
	requestConfig: (row.request_config ?? {}) as Record<string, unknown>,
	nextActionAtMs: numberValue(row.next_action_at),
	leaseOwner: optionalString(row.lease_owner),
	leaseExpiresAtMs: optionalNumber(row.lease_expires_at),
	revision: numberValue(row.revision),
	createdAtMs: numberValue(row.created_at),
	updatedAtMs: numberValue(row.updated_at),
	lastActivityAtMs: numberValue(row.last_activity_at),
	runningSinceMs: optionalNumber(row.running_since),
	deletedAtMs: optionalNumber(row.deleted_at),
});

const commandFromRow = (row: Row): CloudWorkspaceCommandRecord => ({
	commandId: String(row.command_id),
	workspaceId: String(row.workspace_id),
	accountId: String(row.account_id),
	sequence: numberValue(row.sequence),
	kind: row.kind as CloudWorkspaceCommandRecord["kind"],
	payload: (row.payload ?? {}) as Record<string, unknown>,
	state: row.state as CloudWorkspaceCommandRecord["state"],
	createdAtMs: numberValue(row.created_at),
	claimedAtMs: optionalNumber(row.claimed_at),
	acknowledgedAtMs: optionalNumber(row.acknowledged_at),
	failedAtMs: optionalNumber(row.failed_at),
});

const eventFromRow = (row: Row): CloudWorkspaceEventRecord => ({
	workspaceId: String(row.workspace_id),
	runtimeSequence: numberValue(row.runtime_sequence),
	eventId: String(row.event_id),
	streamId: String(row.stream_id),
	streamVersion: numberValue(row.stream_version),
	type: String(row.type),
	payloadJson: String(row.payload_json),
	createdAtMs: numberValue(row.created_at),
});

export const CloudWorkspaceStorePg: Layer.Layer<
	CloudWorkspaceStore,
	never,
	SqlClient.SqlClient
> = Layer.effect(
	CloudWorkspaceStore,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const orDie = <A>(effect: Effect.Effect<A, unknown>): Effect.Effect<A> =>
			effect.pipe(Effect.orDie);
		const saveProject = (p: CloudProjectRecord) =>
			orDie(
				sql`UPDATE relay_cloud_projects SET repository_url=${p.repositoryUrl}, display_name=${p.displayName}, default_branch=${p.defaultBranch}, visibility=${p.visibility}, cloud_environment=${JSON.stringify(p.cloudEnvironment)}::jsonb, secret_bindings=${JSON.stringify(p.secretBindings)}::jsonb, configuration_digest=${p.configurationDigest}, state=${p.state}, last_error_code=${p.lastErrorCode ?? null}, updated_at=${p.updatedAtMs} WHERE project_id=${p.projectId}`.pipe(
					Effect.asVoid,
				),
			);
		const saveBuild = (b: CloudProjectBuildRecord) =>
			orDie(
				sql`UPDATE relay_cloud_project_builds SET provider_sandbox_id=${b.providerSandboxId ?? null}, snapshot_id=${b.snapshotId ?? null}, source_commit=${b.sourceCommit ?? null}, state=${b.state}, last_error_code=${b.lastErrorCode ?? null}, next_action_at=${b.nextActionAtMs}, lease_owner=NULL, lease_expires_at=NULL, revision=${b.revision}, updated_at=${b.updatedAtMs} WHERE build_id=${b.buildId}`.pipe(
					Effect.asVoid,
				),
			);
		const saveWorkspace = (w: CloudWorkspaceRecord) =>
			orDie(
				sql`UPDATE relay_cloud_workspaces SET provider_sandbox_id=${w.providerSandboxId ?? null}, runtime_boot_token_hash=${w.runtimeBootTokenHash ?? null}, runtime_boot_token_expires_at=${w.runtimeBootTokenExpiresAtMs ?? null}, runtime_credential_hash=${w.runtimeCredentialHash ?? null}, runtime_state=${w.runtimeState}, state=${w.state}, desired_state=${w.desiredState}, status_code=${w.statusCode}, credential_epoch=${w.credentialEpoch}, recovery_bundle_key=${w.recoveryBundleKey ?? null}, warm_retention_deadline=${w.warmRetentionDeadlineMs ?? null}, request_config=${JSON.stringify(w.requestConfig)}::jsonb, next_action_at=${w.nextActionAtMs}, lease_owner=NULL, lease_expires_at=NULL, revision=${w.revision}, updated_at=${w.updatedAtMs}, last_activity_at=${w.lastActivityAtMs}, running_since=${w.runningSinceMs ?? null}, deleted_at=${w.deletedAtMs ?? null} WHERE workspace_id=${w.workspaceId} AND (revision < ${w.revision} OR (revision = ${w.revision} AND updated_at <= ${w.updatedAtMs}))`.pipe(
					Effect.asVoid,
				),
			);
		return CloudWorkspaceStore.of({
			connectProject: (p) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${p.accountId}:${p.repositoryIdentity}`}, 0))`;
						const retry =
							yield* sql`SELECT * FROM relay_cloud_projects WHERE account_id=${p.accountId} AND idempotency_key=${p.idempotencyKey} LIMIT 1`;
						if (retry[0]) return projectFromRow(retry[0] as Row);
						const rows =
							yield* sql`INSERT INTO relay_cloud_projects (project_id, account_id, repository_identity, repository_url, display_name, default_branch, visibility, git_connection_kind, cloud_environment, secret_bindings, configuration_digest, state, last_error_code, idempotency_key, created_at, updated_at) VALUES (${p.projectId}, ${p.accountId}, ${p.repositoryIdentity}, ${p.repositoryUrl}, ${p.displayName}, ${p.defaultBranch}, ${p.visibility}, ${p.gitConnectionKind}, ${JSON.stringify(p.cloudEnvironment)}::jsonb, ${JSON.stringify(p.secretBindings)}::jsonb, ${p.configurationDigest}, ${p.state}, ${p.lastErrorCode ?? null}, ${p.idempotencyKey}, ${p.createdAtMs}, ${p.updatedAtMs}) ON CONFLICT (account_id, repository_identity) DO UPDATE SET repository_url=EXCLUDED.repository_url, display_name=EXCLUDED.display_name, default_branch=EXCLUDED.default_branch, visibility=EXCLUDED.visibility, cloud_environment=EXCLUDED.cloud_environment, secret_bindings=EXCLUDED.secret_bindings, configuration_digest=EXCLUDED.configuration_digest, state='connected', last_error_code=NULL, idempotency_key=EXCLUDED.idempotency_key, updated_at=EXCLUDED.updated_at RETURNING *`;
						return projectFromRow(rows[0] as Row);
					}).pipe(sql.withTransaction),
				),
			listProjects: (accountId) =>
				orDie(
					sql`SELECT * FROM relay_cloud_projects WHERE account_id=${accountId} ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => projectFromRow(row as Row))),
					),
				),
			getProject: (id) =>
				orDie(
					sql`SELECT * FROM relay_cloud_projects WHERE project_id=${id}`.pipe(
						Effect.map((rows) =>
							rows[0] ? projectFromRow(rows[0] as Row) : null,
						),
					),
				),
			saveProject,
			createBuild: (b) =>
				orDie(
					sql`INSERT INTO relay_cloud_project_builds (build_id, project_id, account_id, provider, provider_sandbox_id, snapshot_id, source_commit, template_version, configuration_digest, state, last_error_code, idempotency_key, next_action_at, revision, created_at, updated_at) VALUES (${b.buildId}, ${b.projectId}, ${b.accountId}, ${b.provider}, ${b.providerSandboxId ?? null}, ${b.snapshotId ?? null}, ${b.sourceCommit ?? null}, ${b.templateVersion}, ${b.configurationDigest}, ${b.state}, ${b.lastErrorCode ?? null}, ${b.idempotencyKey}, ${b.nextActionAtMs}, ${b.revision}, ${b.createdAtMs}, ${b.updatedAtMs}) ON CONFLICT DO NOTHING RETURNING *`.pipe(
						Effect.flatMap((rows) =>
							rows.length > 0
								? Effect.succeed(buildFromRow(rows[0] as Row))
								: sql`SELECT * FROM relay_cloud_project_builds WHERE project_id=${b.projectId} AND provider=${b.provider} AND idempotency_key=${b.idempotencyKey}`.pipe(
										Effect.map((found) => buildFromRow(found[0] as Row)),
									),
						),
					),
				),
			getActiveBuild: (projectId, provider) =>
				orDie(
					sql`SELECT * FROM relay_cloud_project_builds WHERE project_id=${projectId} AND provider=${provider} AND state='ready' ORDER BY updated_at DESC LIMIT 1`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			getBuild: (id) =>
				orDie(
					sql`SELECT * FROM relay_cloud_project_builds WHERE build_id=${id}`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			claimBuild: (id, leaseOwner, nowMs, leaseExpiresAtMs) =>
				orDie(
					sql`UPDATE relay_cloud_project_builds SET lease_owner=${leaseOwner}, lease_expires_at=${leaseExpiresAtMs} WHERE build_id=${id} AND (lease_expires_at IS NULL OR lease_expires_at <= ${nowMs}) RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? buildFromRow(rows[0] as Row) : null,
						),
					),
				),
			listBuilds: (projectId) =>
				orDie(
					sql`SELECT * FROM relay_cloud_project_builds WHERE project_id=${projectId} ORDER BY created_at`.pipe(
						Effect.map((rows) => rows.map((row) => buildFromRow(row as Row))),
					),
				),
			saveBuild,
			listDueBuilds: (nowMs, limit) =>
				orDie(
					sql`SELECT * FROM relay_cloud_project_builds WHERE state NOT IN ('ready','failed') AND next_action_at <= ${nowMs} ORDER BY next_action_at LIMIT ${limit}`.pipe(
						Effect.map((rows) => rows.map((row) => buildFromRow(row as Row))),
					),
				),
			createWorkspace: (w, command) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${w.projectId}:${w.branch}`}, 0))`;
						const existing =
							yield* sql`SELECT * FROM relay_cloud_workspaces WHERE account_id=${w.accountId} AND idempotency_key=${w.idempotencyKey}`;
						if (existing[0]) {
							return {
								kind: "existing",
								workspace: workspaceFromRow(existing[0] as Row),
							} satisfies CreateCloudWorkspaceOutcome;
						}
						const conflicts =
							yield* sql`SELECT * FROM relay_cloud_workspaces WHERE project_id=${w.projectId} AND branch=${w.branch} AND state <> 'deleted' LIMIT 1`;
						if (conflicts[0]) {
							return {
								kind: "branch-in-use",
								workspace: workspaceFromRow(conflicts[0] as Row),
							} satisfies CreateCloudWorkspaceOutcome;
						}
						const created =
							yield* sql`INSERT INTO relay_cloud_workspaces (workspace_id, account_id, project_id, build_id, provider, runtime_state, chat_id, initial_session_id, branch, base_ref, state, desired_state, status_code, credential_epoch, idempotency_key, request_config, next_action_at, revision, created_at, updated_at, last_activity_at) VALUES (${w.workspaceId}, ${w.accountId}, ${w.projectId}, ${w.buildId}, ${w.provider}, ${w.runtimeState}, ${w.chatId}, ${w.initialSessionId}, ${w.branch}, ${w.baseRef}, ${w.state}, ${w.desiredState}, ${w.statusCode}, ${w.credentialEpoch}, ${w.idempotencyKey}, ${JSON.stringify(w.requestConfig)}::jsonb, ${w.nextActionAtMs}, ${w.revision}, ${w.createdAtMs}, ${w.updatedAtMs}, ${w.lastActivityAtMs}) RETURNING *`;
						yield* sql`INSERT INTO relay_cloud_workspace_commands (command_id, workspace_id, account_id, sequence, kind, payload, state, created_at) VALUES (${command.commandId}, ${command.workspaceId}, ${command.accountId}, ${command.sequence}, ${command.kind}, ${JSON.stringify(command.payload)}::jsonb, ${command.state}, ${command.createdAtMs})`;
						return {
							kind: "created",
							workspace: workspaceFromRow(created[0] as Row),
						} satisfies CreateCloudWorkspaceOutcome;
					}).pipe(sql.withTransaction),
				),
			listWorkspaces: (accountId, projectId) =>
				orDie(
					(projectId === undefined
						? sql`SELECT * FROM relay_cloud_workspaces WHERE account_id=${accountId} ORDER BY created_at`
						: sql`SELECT * FROM relay_cloud_workspaces WHERE account_id=${accountId} AND project_id=${projectId} ORDER BY created_at`
					).pipe(
						Effect.map((rows) =>
							rows.map((row) => workspaceFromRow(row as Row)),
						),
					),
				),
			getWorkspace: (id) =>
				orDie(
					sql`SELECT * FROM relay_cloud_workspaces WHERE workspace_id=${id}`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			claimWorkspace: (id, leaseOwner, nowMs, leaseExpiresAtMs) =>
				orDie(
					sql`UPDATE relay_cloud_workspaces SET lease_owner=${leaseOwner}, lease_expires_at=${leaseExpiresAtMs} WHERE workspace_id=${id} AND (lease_expires_at IS NULL OR lease_expires_at <= ${nowMs}) RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			saveWorkspace,
			consumeRuntimeBoot: (input) =>
				orDie(
					sql`UPDATE relay_cloud_workspaces SET runtime_boot_token_hash=NULL, runtime_boot_token_expires_at=NULL, runtime_credential_hash=${input.runtimeCredentialHash}, runtime_state='connecting', state='setup', status_code='runtime-authenticating', request_config=jsonb_set(jsonb_set(request_config, '{runtimeCredentialExpiresAtMs}', to_jsonb(${input.runtimeCredentialExpiresAtMs}::bigint), true), '{startupTimings}', COALESCE(request_config->'startupTimings', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('enrolledAt', ${input.nowMs}, 'runtimeReadyAt', ${input.nowMs}, 'enrollmentDurationMs', CASE WHEN request_config#>>'{startupTimings,allocatedAt}' IS NULL THEN NULL ELSE ${input.nowMs} - (request_config#>>'{startupTimings,allocatedAt}')::bigint END)), true), next_action_at=${input.nowMs + 30_000}, revision=revision+1, updated_at=${input.nowMs} WHERE workspace_id=${input.workspaceId} AND runtime_boot_token_hash=${input.bootTokenHash} AND runtime_boot_token_expires_at > ${input.nowMs} AND desired_state='ready' AND provider_sandbox_id IS NOT NULL AND state <> 'deleted' RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			listDueWorkspaces: (nowMs, limit) =>
				orDie(
					sql`SELECT * FROM relay_cloud_workspaces WHERE state <> 'deleted' AND next_action_at <= ${nowMs} ORDER BY next_action_at LIMIT ${limit}`.pipe(
						Effect.map((rows) =>
							rows.map((row) => workspaceFromRow(row as Row)),
						),
					),
				),
			recordActivity: (workspaceId, accountId, nowMs, nextIdleAtMs) =>
				orDie(
					sql`UPDATE relay_cloud_workspaces SET desired_state=CASE WHEN state='paused' THEN 'ready' ELSE desired_state END, status_code=CASE WHEN state='paused' THEN 'resume-queued' ELSE status_code END, request_config=CASE WHEN state='paused' THEN jsonb_set(request_config, '{startupTimings}', jsonb_build_object('requestedAt', ${nowMs}, 'resumeRequestedAt', ${nowMs}), true) ELSE request_config END, next_action_at=CASE WHEN state='paused' THEN ${nowMs} WHEN state='ready' THEN ${nextIdleAtMs} ELSE next_action_at END, last_activity_at=${nowMs}, revision=revision+1, updated_at=${nowMs} WHERE workspace_id=${workspaceId} AND account_id=${accountId} AND state <> 'deleted' RETURNING *`.pipe(
						Effect.map((rows) =>
							rows[0] ? workspaceFromRow(rows[0] as Row) : null,
						),
					),
				),
			createConnectionGrant: (input) =>
				orDie(
					sql`INSERT INTO relay_cloud_workspace_connection_grants (grant_hash, workspace_id, account_id, expires_at, created_at) VALUES (${input.grantHash}, ${input.workspaceId}, ${input.accountId}, ${input.expiresAtMs}, ${input.createdAtMs})`.pipe(
						Effect.asVoid,
					),
				),
			consumeConnectionGrant: (grantHash, workspaceId, nowMs) =>
				orDie(
					sql`UPDATE relay_cloud_workspace_connection_grants SET consumed_at=${nowMs} WHERE grant_hash=${grantHash} AND workspace_id=${workspaceId} AND consumed_at IS NULL AND expires_at > ${nowMs} RETURNING grant_hash`.pipe(
						Effect.map((rows) => rows.length > 0),
					),
				),
			createCommand: (command) =>
				orDie(
					sql`INSERT INTO relay_cloud_workspace_commands (command_id, workspace_id, account_id, sequence, kind, payload, state, created_at, claimed_at, acknowledged_at, failed_at) VALUES (${command.commandId}, ${command.workspaceId}, ${command.accountId}, ${command.sequence}, ${command.kind}, ${JSON.stringify(command.payload)}::jsonb, ${command.state}, ${command.createdAtMs}, ${command.claimedAtMs ?? null}, ${command.acknowledgedAtMs ?? null}, ${command.failedAtMs ?? null}) ON CONFLICT (command_id) DO UPDATE SET command_id=EXCLUDED.command_id RETURNING *`.pipe(
						Effect.map((rows) => commandFromRow(rows[0] as Row)),
					),
				),
			listCommands: (workspaceId, afterSequence, nowMs) =>
				orDie(
					sql`UPDATE relay_cloud_workspace_commands SET state='claimed', claimed_at=COALESCE(claimed_at, ${nowMs}) WHERE workspace_id=${workspaceId} AND sequence > ${afterSequence} AND state IN ('queued','claimed') RETURNING *`.pipe(
						Effect.map((rows) =>
							rows
								.map((row) => commandFromRow(row as Row))
								.sort((a, b) => a.sequence - b.sequence),
						),
					),
				),
			acknowledgeCommand: (workspaceId, commandId, nowMs) =>
				orDie(
					sql`UPDATE relay_cloud_workspace_commands SET state='acknowledged', acknowledged_at=${nowMs} WHERE workspace_id=${workspaceId} AND command_id=${commandId} RETURNING command_id`.pipe(
						Effect.map((rows) => rows.length > 0),
					),
				),
			appendEvents: (workspaceId, events) =>
				orDie(
					Effect.gen(function* () {
						let appended = 0;
						for (const event of events) {
							const rows =
								yield* sql`INSERT INTO relay_cloud_workspace_events (workspace_id, runtime_sequence, event_id, stream_id, stream_version, type, payload_json, created_at) VALUES (${workspaceId}, ${event.runtimeSequence}, ${event.eventId}, ${event.streamId}, ${event.streamVersion}, ${event.type}, ${event.payloadJson}, ${event.createdAtMs}) ON CONFLICT DO NOTHING RETURNING runtime_sequence`;
							appended += rows.length;
						}
						return appended;
					}).pipe(sql.withTransaction),
				),
			listEvents: (workspaceId, afterSequence) =>
				orDie(
					sql`SELECT * FROM relay_cloud_workspace_events WHERE workspace_id=${workspaceId} AND runtime_sequence > ${afterSequence} ORDER BY runtime_sequence`.pipe(
						Effect.map((rows) => rows.map((row) => eventFromRow(row as Row))),
					),
				),
			listCredentials: (accountId) =>
				orDie(
					sql`SELECT * FROM relay_cloud_credential_connections WHERE account_id=${accountId} ORDER BY kind`.pipe(
						Effect.map((rows) =>
							rows.map((row) => ({
								connectionId: String(row.connection_id),
								accountId: String(row.account_id),
								kind: row.kind as CloudCredentialKind,
								state: row.state as "connected" | "disconnected" | "error",
								accountLabel: optionalString(row.account_label),
								encryptedPayload: optionalString(row.encrypted_payload),
								encryptionKeyVersion: optionalString(
									row.encryption_key_version,
								),
								credentialVersion: numberValue(row.credential_version),
								createdAtMs: numberValue(row.created_at),
								updatedAtMs: numberValue(row.updated_at),
								disconnectedAtMs: optionalNumber(row.disconnected_at),
							})),
						),
					),
				),
			getCredential: (accountId, kind) =>
				orDie(
					sql`SELECT * FROM relay_cloud_credential_connections WHERE account_id=${accountId} AND kind=${kind} LIMIT 1`.pipe(
						Effect.map((rows) => {
							const row = rows[0];
							return row
								? {
										connectionId: String(row.connection_id),
										accountId: String(row.account_id),
										kind: row.kind as CloudCredentialKind,
										state: row.state as "connected" | "disconnected" | "error",
										accountLabel: optionalString(row.account_label),
										encryptedPayload: optionalString(row.encrypted_payload),
										encryptionKeyVersion: optionalString(
											row.encryption_key_version,
										),
										credentialVersion: numberValue(row.credential_version),
										createdAtMs: numberValue(row.created_at),
										updatedAtMs: numberValue(row.updated_at),
										disconnectedAtMs: optionalNumber(row.disconnected_at),
									}
								: null;
						}),
					),
				),
			saveCredential: (credential) =>
				orDie(
					sql`INSERT INTO relay_cloud_credential_connections (connection_id, account_id, kind, state, account_label, encrypted_payload, encryption_key_version, credential_version, created_at, updated_at, disconnected_at) VALUES (${credential.connectionId}, ${credential.accountId}, ${credential.kind}, ${credential.state}, ${credential.accountLabel ?? null}, ${credential.encryptedPayload ?? null}, ${credential.encryptionKeyVersion ?? null}, ${credential.credentialVersion}, ${credential.createdAtMs}, ${credential.updatedAtMs}, ${credential.disconnectedAtMs ?? null}) ON CONFLICT (account_id, kind) DO UPDATE SET state=EXCLUDED.state, account_label=EXCLUDED.account_label, encrypted_payload=EXCLUDED.encrypted_payload, encryption_key_version=EXCLUDED.encryption_key_version, credential_version=EXCLUDED.credential_version, updated_at=EXCLUDED.updated_at, disconnected_at=EXCLUDED.disconnected_at RETURNING *`.pipe(
						Effect.map((rows) => {
							const row = rows[0] as Row;
							return {
								connectionId: String(row.connection_id),
								accountId: String(row.account_id),
								kind: row.kind as CloudCredentialKind,
								state: row.state as "connected" | "disconnected" | "error",
								accountLabel: optionalString(row.account_label),
								encryptedPayload: optionalString(row.encrypted_payload),
								encryptionKeyVersion: optionalString(
									row.encryption_key_version,
								),
								credentialVersion: numberValue(row.credential_version),
								createdAtMs: numberValue(row.created_at),
								updatedAtMs: numberValue(row.updated_at),
								disconnectedAtMs: optionalNumber(row.disconnected_at),
							};
						}),
					),
				),
			disconnectCredential: (accountId, kind, nowMs) =>
				orDie(
					sql`UPDATE relay_cloud_credential_connections SET state='disconnected', encrypted_payload=NULL, credential_version=credential_version+1, updated_at=${nowMs}, disconnected_at=${nowMs} WHERE account_id=${accountId} AND kind=${kind} RETURNING *`.pipe(
						Effect.map((rows) => {
							const row = rows[0];
							return row
								? {
										connectionId: String(row.connection_id),
										accountId: String(row.account_id),
										kind: row.kind as CloudCredentialKind,
										state: "disconnected" as const,
										accountLabel: optionalString(row.account_label),
										credentialVersion: numberValue(row.credential_version),
										createdAtMs: numberValue(row.created_at),
										updatedAtMs: numberValue(row.updated_at),
										disconnectedAtMs: optionalNumber(row.disconnected_at),
									}
								: null;
						}),
					),
				),
			credentialEpoch: (accountId) =>
				orDie(
					sql`SELECT COALESCE(SUM(credential_version), 0) AS epoch FROM relay_cloud_credential_connections WHERE account_id=${accountId} AND state='connected'`.pipe(
						Effect.map((rows) => numberValue(rows[0]?.epoch ?? 0)),
					),
				),
			deleteAccountData: (accountId) =>
				orDie(
					Effect.gen(function* () {
						yield* sql`DELETE FROM relay_cloud_workspace_usage WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM relay_cloud_workspaces WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM relay_cloud_project_builds WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM relay_cloud_projects WHERE account_id=${accountId}`;
						yield* sql`DELETE FROM relay_cloud_credential_connections WHERE account_id=${accountId}`;
					}).pipe(sql.withTransaction),
				),
			recordUsage: (event) =>
				orDie(
					sql`INSERT INTO relay_cloud_workspace_usage (event_id, workspace_id, account_id, provider, kind, quantity, provider_event_id, occurred_at, created_at) VALUES (${event.eventId}, ${event.workspaceId}, ${event.accountId}, ${event.provider}, ${event.kind}, ${event.quantity}, ${event.providerEventId ?? null}, ${event.occurredAtMs}, ${Date.now()}) ON CONFLICT DO NOTHING RETURNING event_id`.pipe(
						Effect.map((rows) => rows.length > 0),
					),
				),
		});
	}),
);
