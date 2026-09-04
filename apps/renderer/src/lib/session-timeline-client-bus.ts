import {
	ClientBus,
	type ResourceDriver,
	type ResourceLease,
	type ResourceSynchronization,
} from "@zuse/client-runtime/client-bus";
import type {
	ClientCommand,
	ClientCommandExecutor,
	CommandDispatchHandle,
	CommandReceipt,
	PersistedResource,
	ResourcePersistence,
} from "@zuse/client-runtime/client-persistence";
import type {
	EnvironmentFault,
	EnvironmentResolver,
	ResourceActivation,
} from "@zuse/client-runtime/environment-runtime";
import {
	makeResourceKey,
	type ResourceKey,
	resourceKeyId,
	type SessionRef,
} from "@zuse/client-runtime/resource-ref";
import type { ResourceView } from "@zuse/client-runtime/resource-state";
import {
	prependSessionTimelineMessages,
	restoreSessionTimelineState,
} from "@zuse/client-runtime/session-timeline";
import { makeSessionTimelineCacheEntry } from "@zuse/client-runtime/session-timeline-cache";
import { makeSessionTimelineResourceDriver } from "@zuse/client-runtime/session-timeline-driver";
import { cloudCommandEligibility } from "@zuse/cloud-commands";
import type { EnvironmentId, Message } from "@zuse/contracts";
import { ComposerInput, SessionTimelineProjection } from "@zuse/contracts";
import { emptyTimelineProjection } from "@zuse/domain/projectors/timeline-reducer";
import { Effect } from "effect";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import {
	createClientCommandOutbox,
	resetMemoryCommandOutboxForTest,
} from "./client-command-outbox.ts";
import { cloudCommandTransport } from "./cloud-command-transport.ts";
import { cloudFailurePresentation } from "./cloud-failure-presentation.ts";
import {
	acquireRendererRpcSession,
	isAuthCodedConnectionError,
	isCloudWorkspaceEnvironment,
	isRpcClientTransportError,
	type MemoizeClient,
	markCloudWorkspaceConnectionHealthy,
	type RendererRpcSession,
} from "./rpc-client.ts";
import {
	durableOptimisticSessionMessage,
	sessionMessageCommandReflected,
} from "./session-message-intent.ts";
import { sessionTimelineCache } from "./session-timeline-cache.ts";

export type SessionTimelineResourceKey = ResourceKey<SessionTimelineProjection>;

export const sessionTimelineResourceKey = (
	ref: SessionRef,
): SessionTimelineResourceKey =>
	makeResourceKey<SessionTimelineProjection>("session-timeline", ref);

type TimelineCheckpointSynchronizer = (
	ref: SessionRef,
	current: ResourceView<SessionTimelineProjection>,
) => Promise<ResourceSynchronization<SessionTimelineProjection> | null>;

type TimelineOlderPageSynchronizer = (
	ref: SessionRef,
	cursor: NonNullable<ResourceView<SessionTimelineProjection>["cursor"]>,
	beforeSequence: number,
) => Promise<{
	readonly messages: readonly Message[];
	readonly olderMessageSequence: number | null;
} | null>;

const checkpointSynchronizers = new Map<
	EnvironmentId,
	TimelineCheckpointSynchronizer
>();
const olderPageSynchronizers = new Map<
	EnvironmentId,
	TimelineOlderPageSynchronizer
>();

export const registerSessionTimelineCheckpointSynchronizer = (
	environmentId: EnvironmentId,
	synchronize: TimelineCheckpointSynchronizer,
): (() => void) => {
	checkpointSynchronizers.set(environmentId, synchronize);
	return () => {
		if (checkpointSynchronizers.get(environmentId) === synchronize) {
			checkpointSynchronizers.delete(environmentId);
		}
	};
};

export const registerSessionTimelineOlderPageSynchronizer = (
	environmentId: EnvironmentId,
	synchronize: TimelineOlderPageSynchronizer,
): (() => void) => {
	olderPageSynchronizers.set(environmentId, synchronize);
	return () => {
		if (olderPageSynchronizers.get(environmentId) === synchronize) {
			olderPageSynchronizers.delete(environmentId);
		}
	};
};

const sessionRef = (key: ResourceKey<unknown>): SessionRef | null =>
	key.kind === "session-timeline" && "sessionId" in key.ref ? key.ref : null;

class RendererTimelinePersistence implements ResourcePersistence {
	async loadResource<Data>(
		key: ResourceKey<Data>,
	): Promise<PersistedResource<Data> | null> {
		const ref = sessionRef(key);
		if (ref === null || sessionTimelineCache === null) return null;
		const cached = await sessionTimelineCache.load(ref);
		if (cached === null) return null;
		return {
			data: cached.projection as Data,
			cursor: cached.cursor,
			storedAt: cached.savedAt,
		};
	}

	async saveResource<Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	): Promise<void> {
		const ref = sessionRef(key);
		if (
			ref === null ||
			sessionTimelineCache === null ||
			value.cursor === null
		) {
			return;
		}
		await sessionTimelineCache.save(
			makeSessionTimelineCacheEntry({
				ref,
				cursor: value.cursor,
				projection: value.data as SessionTimelineProjection,
				now: value.storedAt,
			}),
		);
		void sessionTimelineCache.prune().catch(() => undefined);
	}

	async removeResource(key: ResourceKey<unknown>): Promise<void> {
		const ref = sessionRef(key);
		if (ref !== null) await sessionTimelineCache?.remove(ref);
	}
}

export type RendererResourcePersistence = ResourcePersistence;

const timelinePersistence = new RendererTimelinePersistence();
const registeredPersistence = new Map<string, ResourcePersistence>([
	["session-timeline", timelinePersistence],
]);

/**
 * Routes persistence by resource kind while keeping one ClientBus. Register
 * adapters during module/bootstrap setup, before retaining that resource kind.
 */
export const registerRendererResourcePersistence = (
	kind: string,
	persistence: RendererResourcePersistence,
): (() => void) => {
	// Registration is a single replaceable slot per resource kind. Vite HMR
	// evaluates the replacement module before disposing the previous instance, so
	// rejecting a new object here crashes the renderer during development. The
	// identity-checked cleanup below prevents the old module from deleting the
	// replacement when its dispose callback eventually runs.
	registeredPersistence.set(kind, persistence);
	return () => {
		if (
			kind !== "session-timeline" &&
			registeredPersistence.get(kind) === persistence
		) {
			registeredPersistence.delete(kind);
		}
	};
};

const rendererResourcePersistence: ResourcePersistence = {
	loadResource: <Data>(key: ResourceKey<Data>) =>
		registeredPersistence.get(key.kind)?.loadResource(key) ??
		Promise.resolve(null),
	saveResource: <Data>(
		key: ResourceKey<Data>,
		value: PersistedResource<Data>,
	) =>
		registeredPersistence.get(key.kind)?.saveResource(key, value) ??
		Promise.resolve(),
	removeResource: (key) =>
		registeredPersistence.get(key.kind)?.removeResource(key) ??
		Promise.resolve(),
};

/**
 * IndexedDB's structured clone deliberately strips class prototypes. Effect's
 * RPC encoder validates `Schema.Class` identity, so nested composer payloads
 * must be reconstructed at the single command-executor boundary. Doing this
 * here keeps fresh dispatches and durable outbox replays wire-identical.
 */
export const rehydrateRendererCommandPayload = (
	kind: string,
	value: unknown,
): Readonly<Record<string, unknown>> => {
	const payload = value as Readonly<Record<string, unknown>>;
	const inputKey = kind === "chat.create" ? "startupInput" : "input";
	if (
		kind !== "chat.create" &&
		kind !== "messages.send" &&
		kind !== "messages.queue.add" &&
		kind !== "messages.queue.update"
	)
		return payload;
	const input = payload[inputKey];
	if (typeof input !== "object" || input === null) return payload;
	return { ...payload, [inputKey]: ComposerInput.make(input as ComposerInput) };
};

const executeSessionCommand: ClientCommandExecutor<MemoizeClient> = {
	execute: async (client, command) => {
		const payload = rehydrateRendererCommandPayload(
			command.kind,
			command.payload,
		);
		let result: unknown;
		switch (command.kind) {
			case "workspace.setSelected":
				result = await Effect.runPromise(
					client["workspace.setSelected"](payload as never),
				);
				break;
			case "workspace.getSelected":
				result = await Effect.runPromise(
					client["workspace.getSelected"](payload as never),
				);
				break;
			case "workspace.remove":
				result = await Effect.runPromise(
					client["workspace.remove"](payload as never),
				);
				break;
			case "workspace.add":
				result = await Effect.runPromise(
					client["workspace.add"](payload as never),
				);
				break;
			case "workspace.pickFolder":
				result = await Effect.runPromise(
					client["workspace.pickFolder"](payload as never),
				);
				break;
			case "workspace.listGithubRepos":
				result = await Effect.runPromise(
					client["workspace.listGithubRepos"](payload as never),
				);
				break;
			case "workspace.ghAuthStatus":
				result = await Effect.runPromise(
					client["workspace.ghAuthStatus"](payload as never),
				);
				break;
			case "workspace.cloneRepo":
				result = await Effect.runPromise(
					client["workspace.cloneRepo"](payload as never),
				);
				break;
			case "workspace.createProject":
				result = await Effect.runPromise(
					client["workspace.createProject"](payload as never),
				);
				break;
			case "workspace.browseDirectory":
				result = await Effect.runPromise(
					client["workspace.browseDirectory"](payload as never),
				);
				break;
			case "attachments.upload":
				result = await Effect.runPromise(
					client["attachments.upload"](payload as never),
				);
				break;
			case "externalThreads.list":
				result = await Effect.runPromise(
					client["externalThreads.list"](payload as never),
				);
				break;
			case "externalThreads.continue":
				result = await Effect.runPromise(
					client["externalThreads.continue"](payload as never),
				);
				break;
			case "usage.sessions":
				result = await Effect.runPromise(
					client["usage.sessions"](payload as never),
				);
				break;
			case "usage.limits":
				result = await Effect.runPromise(
					client["usage.limits"](payload as never),
				);
				break;
			case "usage.limits.history":
				result = await Effect.runPromise(
					client["usage.limits.history"](payload as never),
				);
				break;
			case "session.rename":
				result = await Effect.runPromise(
					client["session.rename"](payload as never),
				);
				break;
			case "session.setRuntimeMode":
				result = await Effect.runPromise(
					client["session.setRuntimeMode"](payload as never),
				);
				break;
			case "session.setPermissionMode":
				result = await Effect.runPromise(
					client["session.setPermissionMode"](payload as never),
				);
				break;
			case "session.create":
				result = await Effect.runPromise(
					client["session.create"](payload as never),
				);
				break;
			case "session.fork":
				result = await Effect.runPromise(
					client["session.fork"](payload as never),
				);
				break;
			case "session.setModel":
				result = await Effect.runPromise(
					client["session.setModel"](payload as never),
				);
				break;
			case "session.setProvider":
				result = await Effect.runPromise(
					client["session.setProvider"](payload as never),
				);
				break;
			case "session.answerQuestion":
				result = await Effect.runPromise(
					client["session.answerQuestion"](payload as never),
				);
				break;
			case "session.plan.respond":
				result = await Effect.runPromise(
					client["session.plan.respond"](payload as never),
				);
				break;
			case "session.archive":
				result = await Effect.runPromise(
					client["session.archive"](payload as never),
				);
				break;
			case "session.unarchive":
				result = await Effect.runPromise(
					client["session.unarchive"](payload as never),
				);
				break;
			case "session.delete":
				result = await Effect.runPromise(
					client["session.delete"](payload as never),
				);
				break;
			case "session.resume":
				result = await Effect.runPromise(
					client["session.resume"](payload as never),
				);
				break;
			case "session.get":
				result = await Effect.runPromise(
					client["session.get"](payload as never),
				);
				break;
			case "context.saveText":
				result = await Effect.runPromise(
					client["context.saveText"](payload as never),
				);
				break;
			case "session.latestPlan":
				result = await Effect.runPromise(
					client["session.latestPlan"](payload as never),
				);
				break;
			case "session.exportTranscript":
				result = await Effect.runPromise(
					client["session.exportTranscript"](payload as never),
				);
				break;
			case "chat.create":
				result = await Effect.runPromise(
					client["chat.create"](payload as never),
				);
				break;
			case "chat.rename":
				result = await Effect.runPromise(
					client["chat.rename"](payload as never),
				);
				break;
			case "chat.setWorktree":
				result = await Effect.runPromise(
					client["chat.setWorktree"](payload as never),
				);
				break;
			case "chat.setActiveSession":
				result = await Effect.runPromise(
					client["chat.setActiveSession"](payload as never),
				);
				break;
			case "chat.markRead":
				result = await Effect.runPromise(
					client["chat.markRead"](payload as never),
				);
				break;
			case "chat.archive":
				result = await Effect.runPromise(
					client["chat.archive"](payload as never),
				);
				break;
			case "chat.unarchive":
				result = await Effect.runPromise(
					client["chat.unarchive"](payload as never),
				);
				break;
			case "chat.delete":
				result = await Effect.runPromise(
					client["chat.delete"](payload as never),
				);
				break;
			case "chat.get":
				result = await Effect.runPromise(client["chat.get"](payload as never));
				break;
			case "chat.list":
				result = await Effect.runPromise(client["chat.list"](payload as never));
				break;
			case "chat.archivePreview":
				result = await Effect.runPromise(
					client["chat.archivePreview"](payload as never),
				);
				break;
			case "chat.directoryStatus":
				result = await Effect.runPromise(
					client["chat.directoryStatus"](payload as never),
				);
				break;
			case "chat.archiveStatus":
				result = await Effect.runPromise(
					client["chat.archiveStatus"](payload as never),
				);
				break;
			case "chat.creation.discard":
				result = await Effect.runPromise(
					client["chat.creation.discard"](payload as never),
				);
				break;
			case "chat.archiveJobs":
				result = await Effect.runPromise(
					client["chat.archiveJobs"](payload as never),
				);
				break;
			case "chat.creation.list":
				result = await Effect.runPromise(
					client["chat.creation.list"](payload as never),
				);
				break;
			case "skill.listForProject":
				result = await Effect.runPromise(
					client["skill.listForProject"](payload as never),
				);
				break;
			case "permission.decide":
				result = await Effect.runPromise(
					client["permission.decide"](payload as never),
				);
				break;
			case "permission.listDecisions":
				result = await Effect.runPromise(
					client["permission.listDecisions"](payload as never),
				);
				break;
			case "permission.revokeDecision":
				result = await Effect.runPromise(
					client["permission.revokeDecision"](payload as never),
				);
				break;
			case "browser.respond":
				result = await Effect.runPromise(
					client["browser.respond"](payload as never),
				);
				break;
			case "auth.signIn":
				result = await Effect.runPromise(
					client["auth.signIn"](payload as never),
				);
				break;
			case "auth.signOut":
				result = await Effect.runPromise(
					client["auth.signOut"](payload as never),
				);
				break;
			case "keybindings.replace":
				result = await Effect.runPromise(
					client["keybindings.replace"](payload as never),
				);
				break;
			case "settings.update":
				result = await Effect.runPromise(
					client["settings.update"](payload as never),
				);
				break;
			case "repositorySettings.get":
				result = await Effect.runPromise(
					client["repositorySettings.get"](payload as never),
				);
				break;
			case "repositorySettings.update":
				result = await Effect.runPromise(
					client["repositorySettings.update"](payload as never),
				);
				break;
			case "provider.availability":
				result = await Effect.runPromise(
					client["provider.availability"](payload as never),
				);
				break;
			case "provider.setCredential":
				result = await Effect.runPromise(
					client["provider.setCredential"](payload as never),
				);
				break;
			case "provider.removeCredential":
				result = await Effect.runPromise(
					client["provider.removeCredential"](payload as never),
				);
				break;
			case "provider.opencode.inventory":
				result = await Effect.runPromise(
					client["provider.opencode.inventory"](payload as never),
				);
				break;
			case "provider.opencode.setAuth":
				result = await Effect.runPromise(
					client["provider.opencode.setAuth"](payload as never),
				);
				break;
			case "provider.opencode.removeAuth":
				result = await Effect.runPromise(
					client["provider.opencode.removeAuth"](payload as never),
				);
				break;
			case "provider.opencode.addCustom":
				result = await Effect.runPromise(
					client["provider.opencode.addCustom"](payload as never),
				);
				break;
			case "provider.opencode.removeCustom":
				result = await Effect.runPromise(
					client["provider.opencode.removeCustom"](payload as never),
				);
				break;
			case "provider.kiro.inventory":
				result = await Effect.runPromise(
					client["provider.kiro.inventory"](payload as never),
				);
				break;
			case "pokemon.pokedex":
				result = await Effect.runPromise(
					client["pokemon.pokedex"](payload as never),
				);
				break;
			case "pokemon.ensureSpriteCached":
				result = await Effect.runPromise(
					client["pokemon.ensureSpriteCached"](payload as never),
				);
				break;
			case "mcp.list":
				result = await Effect.runPromise(client["mcp.list"](payload as never));
				break;
			case "mcp.refresh":
				result = await Effect.runPromise(
					client["mcp.refresh"](payload as never),
				);
				break;
			case "mcp.setEnabled":
				result = await Effect.runPromise(
					client["mcp.setEnabled"](payload as never),
				);
				break;
			case "session.goal.set":
				result = await Effect.runPromise(
					client["session.goal.set"](payload as never),
				);
				break;
			case "session.goal.clear":
				result = await Effect.runPromise(
					client["session.goal.clear"](payload as never),
				);
				break;
			case "fs.writeFile":
				result = await Effect.runPromise(
					client["fs.writeFile"](payload as never),
				);
				break;
			case "fs.readFile":
				result = await Effect.runPromise(
					client["fs.readFile"](payload as never),
				);
				break;
			case "fs.move":
				result = await Effect.runPromise(client["fs.move"](payload as never));
				break;
			case "fs.createFile":
				result = await Effect.runPromise(
					client["fs.createFile"](payload as never),
				);
				break;
			case "fs.createDirectory":
				result = await Effect.runPromise(
					client["fs.createDirectory"](payload as never),
				);
				break;
			case "fs.remove":
				result = await Effect.runPromise(client["fs.remove"](payload as never));
				break;
			case "git.revertAll":
				result = await Effect.runPromise(
					client["git.revertAll"](payload as never),
				);
				break;
			case "git.revertFile":
				result = await Effect.runPromise(
					client["git.revertFile"](payload as never),
				);
				break;
			case "git.commit":
				result = await Effect.runPromise(
					client["git.commit"](payload as never),
				);
				break;
			case "git.push":
				result = await Effect.runPromise(client["git.push"](payload as never));
				break;
			case "git.reviewIdentity":
				result = await Effect.runPromise(
					client["git.reviewIdentity"](payload as never),
				);
				break;
			case "git.reviewFileContents":
				result = await Effect.runPromise(
					client["git.reviewFileContents"](payload as never),
				);
				break;
			case "git.restoreFileToBase":
				result = await Effect.runPromise(
					client["git.restoreFileToBase"](payload as never),
				);
				break;
			case "git.createReviewComment":
				result = await Effect.runPromise(
					client["git.createReviewComment"](payload as never),
				);
				break;
			case "git.resolveConflict":
				result = await Effect.runPromise(
					client["git.resolveConflict"](payload as never),
				);
				break;
			case "git.branches":
				result = await Effect.runPromise(
					client["git.branches"](payload as never),
				);
				break;
			case "git.switchBranch":
				result = await Effect.runPromise(
					client["git.switchBranch"](payload as never),
				);
				break;
			case "worktree.renameBranch":
				result = await Effect.runPromise(
					client["worktree.renameBranch"](payload as never),
				);
				break;
			case "worktree.rerunSetup":
				result = await Effect.runPromise(
					client["worktree.rerunSetup"](payload as never),
				);
				break;
			case "worktree.startRun":
				result = await Effect.runPromise(
					client["worktree.startRun"](payload as never),
				);
				break;
			case "worktree.remove":
				result = await Effect.runPromise(
					client["worktree.remove"](payload as never),
				);
				break;
			case "worktree.list":
				result = await Effect.runPromise(
					client["worktree.list"](payload as never),
				);
				break;
			case "worktree.create":
				result = await Effect.runPromise(
					client["worktree.create"](payload as never),
				);
				break;
			case "git.markReady":
				result = await Effect.runPromise(
					client["git.markReady"](payload as never),
				);
				break;
			case "git.mergePr":
				result = await Effect.runPromise(
					client["git.mergePr"](payload as never),
				);
				break;
			case "git.fixFailingChecks":
				result = await Effect.runPromise(
					client["git.fixFailingChecks"](payload as never),
				);
				break;
			case "git.diff":
				result = await Effect.runPromise(client["git.diff"](payload as never));
				break;
			case "git.issueMarkdown":
				result = await Effect.runPromise(
					client["git.issueMarkdown"](payload as never),
				);
				break;
			case "git.listPrs":
				result = await Effect.runPromise(
					client["git.listPrs"](payload as never),
				);
				break;
			case "git.listIssues":
				result = await Effect.runPromise(
					client["git.listIssues"](payload as never),
				);
				break;
			case "linear.listConnections":
				result = await Effect.runPromise(
					client["linear.listConnections"](payload as never),
				);
				break;
			case "linear.listIssues":
				result = await Effect.runPromise(
					client["linear.listIssues"](payload as never),
				);
				break;
			case "linear.connect":
				result = await Effect.runPromise(
					client["linear.connect"](payload as never),
				);
				break;
			case "linear.disconnect":
				result = await Effect.runPromise(
					client["linear.disconnect"](payload as never),
				);
				break;
			case "linear.prepareContext":
				result = await Effect.runPromise(
					client["linear.prepareContext"](payload as never),
				);
				break;
			case "workspace.searchFiles":
				result = await Effect.runPromise(
					client["workspace.searchFiles"](payload as never),
				);
				break;
			case "browser.listCredentials":
				result = await Effect.runPromise(
					client["browser.listCredentials"](payload as never),
				);
				break;
			case "browser.setCredential":
				result = await Effect.runPromise(
					client["browser.setCredential"](payload as never),
				);
				break;
			case "browser.removeCredential":
				result = await Effect.runPromise(
					client["browser.removeCredential"](payload as never),
				);
				break;
			case "diagnostics.ingest":
				result = await Effect.runPromise(
					client["diagnostics.ingest"](payload as never),
				);
				break;
			case "diagnostics.overview":
				result = await Effect.runPromise(
					client["diagnostics.overview"](payload as never),
				);
				break;
			case "diagnostics.events":
				result = await Effect.runPromise(
					client["diagnostics.events"](payload as never),
				);
				break;
			case "diagnostics.processes":
				result = await Effect.runPromise(
					client["diagnostics.processes"](payload as never),
				);
				break;
			case "diagnostics.export":
				result = await Effect.runPromise(
					client["diagnostics.export"](payload as never),
				);
				break;
			case "diagnostics.capture":
				result = await Effect.runPromise(
					client["diagnostics.capture"](payload as never),
				);
				break;
			case "diagnostics.signalProcess":
				result = await Effect.runPromise(
					client["diagnostics.signalProcess"](payload as never),
				);
				break;
			case "pairing.listNearbyRequests":
				result = await Effect.runPromise(
					client["pairing.listNearbyRequests"](payload as never),
				);
				break;
			case "pairing.resolveNearbyRequest":
				result = await Effect.runPromise(
					client["pairing.resolveNearbyRequest"](payload as never),
				);
				break;
			case "usage.report":
				result = await Effect.runPromise(
					client["usage.report"](payload as never),
				);
				break;
			case "api.status":
				result = await Effect.runPromise(client["api.status"]());
				break;
			case "api.environments":
				result = await Effect.runPromise(client["api.environments"]());
				break;
			case "api.link":
				result = await Effect.runPromise(client["api.link"](payload as never));
				break;
			case "api.unlink":
				result = await Effect.runPromise(client["api.unlink"]());
				break;
			case "pairing.start":
				result = await Effect.runPromise(
					client["pairing.start"](payload as never),
				);
				break;
			case "pairing.listTokens":
				result = await Effect.runPromise(
					client["pairing.listTokens"](payload as never),
				);
				break;
			case "pairing.revokeToken":
				result = await Effect.runPromise(
					client["pairing.revokeToken"](payload as never),
				);
				break;
			case "fs.readExternalFile":
				result = await Effect.runPromise(
					client["fs.readExternalFile"](payload as never),
				);
				break;
			case "fs.writeExternalFile":
				result = await Effect.runPromise(
					client["fs.writeExternalFile"](payload as never),
				);
				break;
			case "machine.privateNetwork.status":
				result = await Effect.runPromise(
					client["machine.privateNetwork.status"](),
				);
				break;
			case "machine.privateNetwork.enable":
				result = await Effect.runPromise(
					client["machine.privateNetwork.enable"](payload as never),
				);
				break;
			case "machine.sshMode.set":
				result = await Effect.runPromise(
					client["machine.sshMode.set"](payload as never),
				);
				break;
			case "machine.sshKeys.list":
				result = await Effect.runPromise(client["machine.sshKeys.list"]());
				break;
			case "machine.sshKeys.add":
				result = await Effect.runPromise(
					client["machine.sshKeys.add"](payload as never),
				);
				break;
			case "machine.sshKeys.remove":
				result = await Effect.runPromise(
					client["machine.sshKeys.remove"](payload as never),
				);
				break;
			case "machine.runtime.status":
				result = await Effect.runPromise(
					client["machine.runtime.status"](payload as never),
				);
				break;
			case "machine.runtime.update":
				result = await Effect.runPromise(
					client["machine.runtime.update"](payload as never),
				);
				break;
			case "pty.open":
				result = await Effect.runPromise(client["pty.open"](payload as never));
				break;
			case "pty.write":
				result = await Effect.runPromise(client["pty.write"](payload as never));
				break;
			case "pty.resize":
				result = await Effect.runPromise(
					client["pty.resize"](payload as never),
				);
				break;
			case "pty.close":
				result = await Effect.runPromise(client["pty.close"](payload as never));
				break;
			case "messages.send":
				result = await Effect.runPromise(
					client["messages.send"](payload as never),
				);
				break;
			case "messages.interrupt":
				result = await Effect.runPromise(
					client["messages.interrupt"](payload as never),
				);
				break;
			case "messages.queue.add":
				result = await Effect.runPromise(
					client["messages.queue.add"](payload as never),
				);
				break;
			case "messages.queue.update":
				result = await Effect.runPromise(
					client["messages.queue.update"](payload as never),
				);
				break;
			case "messages.queue.delete":
				result = await Effect.runPromise(
					client["messages.queue.delete"](payload as never),
				);
				break;
			case "messages.queue.reorder":
				result = await Effect.runPromise(
					client["messages.queue.reorder"](payload as never),
				);
				break;
			case "messages.queue.flush":
				result = await Effect.runPromise(
					client["messages.queue.flush"](payload as never),
				);
				break;
			case "messages.queue.resume":
				result = await Effect.runPromise(
					client["messages.queue.resume"](payload as never),
				);
				break;
			case "messages.queue.runNext":
				result = await Effect.runPromise(
					client["messages.queue.runNext"](payload as never),
				);
				break;
			default:
				throw new Error(`Unsupported ClientBus command: ${command.kind}`);
		}
		return {
			commandId: command.commandId,
			receivedAt: Date.now(),
			result,
		};
	},
};

let commandOutbox = createClientCommandOutbox();

type EnvironmentActivation = Readonly<{
	/** The catalog authority that registered this resolver. */
	readonly environmentKind: "cloud-workspace" | "other";
	prepare: (activation: "connect" | "wake") => Promise<void>;
	prepareClient?: (client: MemoizeClient) => Promise<void>;
}>;
const activationByEnvironment = new Map<EnvironmentId, EnvironmentActivation>();
const environmentOf = (environmentId: EnvironmentId): EnvironmentId =>
	environmentId;
type ResolveRendererSession = (
	environmentId: EnvironmentId,
	onClose: (cause: Error) => void,
) => Promise<RendererRpcSession>;
const defaultResolveRendererSession: ResolveRendererSession = (
	environmentId,
	onClose,
) => acquireRendererRpcSession(environmentOf(environmentId), { onClose });
let resolveRendererSession = defaultResolveRendererSession;
let reportPassiveSessionFault: (
	environmentId: EnvironmentId,
	fault: EnvironmentFault,
	expectedGeneration: number,
) => boolean = () => false;

export const registerEnvironmentActivation = (
	environmentId: EnvironmentId,
	prepare: EnvironmentActivation["prepare"],
	prepareClient?: EnvironmentActivation["prepareClient"],
	environmentKind: EnvironmentActivation["environmentKind"] = "other",
): (() => void) => {
	const registration = { environmentKind, prepare, prepareClient };
	activationByEnvironment.set(environmentId, registration);
	if (environmentKind === "cloud-workspace") {
		// Catalog hydration can happen after ClientBus's initial outbox scan. Resume
		// durable rows as soon as their stable environment identity is known; this
		// does not acquire a gateway ticket or wake compute.
		void rendererClientBus
			.flushDurableOutbox(environmentId)
			.catch(() => undefined);
	}
	return () => {
		if (activationByEnvironment.get(environmentId) === registration) {
			activationByEnvironment.delete(environmentId);
		}
	};
};

const faultFor = (cause: unknown): EnvironmentFault => {
	const code =
		typeof cause === "object" && cause !== null && "code" in cause
			? String(cause.code)
			: "";
	const presentation = cloudFailurePresentation({ cause });
	const message =
		code ||
		(cause instanceof Error && cause.message !== ""
			? cause.message
			: (presentation?.kind ?? String(cause)));
	const phase: EnvironmentFault["phase"] =
		globalThis.navigator?.onLine === false
			? "offline"
			: presentation?.kind === "update-required"
				? "update-required"
				: presentation?.kind === "cloud-access-required" ||
						presentation?.kind === "cloud-access-unavailable"
					? "revoked"
					: isAuthCodedConnectionError(cause) ||
							presentation?.kind === "sign-in-required"
						? "blocked-auth"
						: "failed";
	return { phase, message };
};

const environmentResolver: EnvironmentResolver<MemoizeClient> = {
	resolve: (environmentId, activation) =>
		Effect.tryPromise({
			try: async () => {
				const registered = activationByEnvironment.get(environmentId);
				// Cloud gateway discovery/ticket issuance must finish before socket
				// acquisition. Keeping this inside the EnvironmentRuntime resolver
				// prevents chat navigation and ClientBus from racing two attach paths.
				await registered?.prepare(activation);
				let generation: number | null = null;
				let pendingFault: Error | null = null;
				const session = await resolveRendererSession(environmentId, (cause) => {
					if (generation === null) {
						pendingFault = cause;
						return;
					}
					reportPassiveSessionFault(environmentId, faultFor(cause), generation);
				});
				try {
					await registered?.prepareClient?.(session.client);
				} catch (cause) {
					await session.dispose();
					throw cause;
				}
				return {
					...session,
					onActivated: (activeGeneration: number) => {
						generation = activeGeneration;
						if (pendingFault === null) {
							if (isCloudWorkspaceEnvironment(environmentId))
								markCloudWorkspaceConnectionHealthy(environmentId);
							return;
						}
						const fault = pendingFault;
						pendingFault = null;
						queueMicrotask(() => {
							reportPassiveSessionFault(
								environmentId,
								faultFor(fault),
								activeGeneration,
							);
						});
					},
				};
			},
			catch: faultFor,
		}),
};

const makeTimelineDriver = (
	reportFailure: (
		environmentId: EnvironmentId,
		generation: number,
		cause: unknown,
	) => void,
): ResourceDriver<MemoizeClient, SessionTimelineProjection> =>
	makeSessionTimelineResourceDriver<MemoizeClient>({
		reportFailure,
	});

type RendererResourceDriverFactory = (
	key: ResourceKey<unknown>,
) => ResourceDriver<MemoizeClient, unknown> | null;

const registeredDriverFactories = new Map<
	string,
	RendererResourceDriverFactory
>();

export const registerRendererResourceDriver = (
	kind: string,
	factory: RendererResourceDriverFactory,
): (() => void) => {
	// One slot still means one owner: replacement changes which factory future
	// resource activations use; it never starts a second driver for an existing
	// resource. Identity-checked cleanup makes this safe when HMR installs the new
	// module before disposing the old one.
	registeredDriverFactories.set(kind, factory);
	return () => {
		if (registeredDriverFactories.get(kind) === factory) {
			registeredDriverFactories.delete(kind);
		}
	};
};

const createBus = (): ClientBus<MemoizeClient> => {
	let bus: ClientBus<MemoizeClient>;
	bus = new ClientBus<MemoizeClient>({
		resolver: environmentResolver,
		persistence: rendererResourcePersistence,
		outbox: commandOutbox,
		commandExecutor: executeSessionCommand,
		commandTransportFor: (environmentId, kind) =>
			activationByEnvironment.get(environmentId)?.environmentKind ===
				"cloud-workspace" &&
			kind === "messages.send" &&
			cloudCommandEligibility(kind) !== undefined
				? cloudCommandTransport
				: undefined,
		commandFaultFor: (cause) =>
			isRpcClientTransportError(cause) ? faultFor(cause) : null,
		commandReflected: sessionMessageCommandReflected,
		runtime: {
			isOnline: () => globalThis.navigator?.onLine !== false,
		},
		synchronizer: {
			synchronize: async <Data>(
				key: ResourceKey<Data>,
				current: ResourceView<Data>,
			) => {
				const ref = sessionRef(key);
				if (ref === null) return null;
				const synchronize = checkpointSynchronizers.get(ref.environmentId);
				if (synchronize === undefined) return null;
				return (await synchronize(
					ref,
					current as ResourceView<SessionTimelineProjection>,
				)) as ResourceSynchronization<Data> | null;
			},
		},
		driverFor: (key) => {
			if (key.kind === "session-timeline") {
				return makeTimelineDriver((environmentId, generation, cause) => {
					if (!isRpcClientTransportError(cause)) return;
					bus.reportConnectionFault(
						environmentId,
						{ phase: "failed", message: faultFor(cause).message },
						generation,
					);
				}) as ResourceDriver<MemoizeClient, unknown>;
			}
			return registeredDriverFactories.get(key.kind)?.(key) ?? null;
		},
	});
	return bus;
};

let rendererClientBus = createBus();
const optimisticRestorationByResource = new Map<string, Promise<void>>();
reportPassiveSessionFault = (environmentId, fault, expectedGeneration) =>
	rendererClientBus.reportConnectionFault(
		environmentId,
		fault,
		expectedGeneration,
	);

export type OlderSessionMessagesResult = Readonly<{
	applied: boolean;
	loaded: number;
	hasMore: boolean;
}>;

const olderSessionMessageLoads = new Map<
	string,
	Promise<OlderSessionMessagesResult>
>();

export const getRendererClientBus = (): ClientBus<MemoizeClient> =>
	rendererClientBus;

/**
 * Loads one bounded older page into the canonical timeline resource. Requests
 * for the same qualified session key are single-flighted. A reconnect, stream
 * advance, reset, or a newer page cursor fences the response before mutation;
 * pagination never owns or advances the durable event cursor.
 */
export const loadOlderSessionMessages = (
	ref: SessionRef,
): Promise<OlderSessionMessagesResult> => {
	const key = sessionTimelineResourceKey(ref);
	const id = resourceKeyId(key);
	const inFlight = olderSessionMessageLoads.get(id);
	if (inFlight !== undefined) return inFlight;

	const bus = rendererClientBus;
	const initial = bus.snapshot(key);
	const beforeSequence = initial.data?.olderMessageSequence ?? null;
	if (initial.data === null || beforeSequence === null) {
		return Promise.resolve({
			applied: false,
			loaded: 0,
			hasMore: beforeSequence !== null,
		});
	}
	const expectedGeneration = initial.generation;
	const expectedCursor = initial.cursor;

	const request = (async (): Promise<OlderSessionMessagesResult> => {
		const client = bus.client(ref.environmentId);
		const page =
			client === null
				? expectedCursor === null
					? null
					: await olderPageSynchronizers.get(ref.environmentId)?.(
							ref,
							expectedCursor,
							beforeSequence,
						)
				: await Effect.runPromise(
						client["session.messages.page"]({
							sessionId: ref.sessionId,
							beforeSequence,
							limit: 100,
						}),
					);
		if (page === null || page === undefined) {
			return { applied: false, loaded: 0, hasMore: true };
		}
		if (bus !== rendererClientBus) {
			return { applied: false, loaded: 0, hasMore: true };
		}

		let loaded = 0;
		const applied = bus.update(key, {
			expectedGeneration,
			expectedCursor,
			persist: page.olderMessageSequence === null,
			update: (projection) => {
				// A prior page can change this cursor without changing the stream
				// cursor. Never apply a response to a different pagination head.
				if ((projection.olderMessageSequence ?? null) !== beforeSequence) {
					return undefined;
				}
				const merged = prependSessionTimelineMessages(
					restoreSessionTimelineState(projection, expectedCursor),
					page.messages,
					page.olderMessageSequence,
				);
				loaded = Math.max(
					0,
					(merged.projection?.messages.length ?? 0) -
						projection.messages.length,
				);
				return merged.projection ?? undefined;
			},
		});
		return {
			applied,
			loaded: applied ? loaded : 0,
			hasMore: applied ? page.olderMessageSequence !== null : true,
		};
	})();
	olderSessionMessageLoads.set(id, request);
	const clear = (): void => {
		if (olderSessionMessageLoads.get(id) === request) {
			olderSessionMessageLoads.delete(id);
		}
	};
	void request.then(clear, clear);
	return request;
};

export const completeOlderSessionMessages = async (
	ref: SessionRef,
	options?: {
		readonly maxAttempts?: number;
		readonly retryDelay?: (attempt: number) => Promise<void>;
	},
): Promise<void> => {
	const maxAttempts = options?.maxAttempts ?? 10;
	const retryDelay =
		options?.retryDelay ??
		((attempt: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, Math.min(4_000, 100 * 2 ** attempt));
			}));
	let attempt = 0;
	for (;;) {
		try {
			const result = await loadOlderSessionMessages(ref);
			if (result.applied) {
				attempt = 0;
				if (!result.hasMore) return;
				continue;
			}
		} catch (cause) {
			if (attempt + 1 >= maxAttempts) throw cause;
		}
		if (attempt + 1 >= maxAttempts) {
			throw new Error("Cloud transcript history remained unavailable");
		}
		await retryDelay(attempt);
		attempt += 1;
	}
};

export const dispatchSessionCommand = <Payload, Result>(input: {
	readonly ref: SessionRef;
	readonly kind: string;
	readonly commandId: ClientCommand["commandId"];
	readonly payload: Payload;
	readonly retry?: ClientCommand["retry"];
}): Promise<CommandReceipt<Result>> =>
	rendererClientBus.dispatch({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.ref.environmentId,
		resource: sessionTimelineResourceKey(input.ref),
		payload: input.payload,
		retry: input.retry ?? "safe",
		createdAt: Date.now(),
		awaitResourceReflection: input.kind === "messages.send",
	});

export const dispatchSessionCommandHandle = <Payload, Result>(input: {
	readonly ref: SessionRef;
	readonly kind: string;
	readonly commandId: ClientCommand["commandId"];
	readonly payload: Payload;
	readonly retry?: ClientCommand["retry"];
}): CommandDispatchHandle<Result> =>
	rendererClientBus.dispatchHandle({
		kind: input.kind,
		commandId: input.commandId,
		environmentId: input.ref.environmentId,
		resource: sessionTimelineResourceKey(input.ref),
		payload: input.payload,
		retry: input.retry ?? "safe",
		createdAt: Date.now(),
		awaitResourceReflection: input.kind === "messages.send",
	});

export const cancelSessionCommand = (commandId: ClientCommand["commandId"]) =>
	rendererClientBus.cancelCommand(commandId);

/** Adds a stable-id optimistic message to the canonical timeline cell. */
export const addOptimisticSessionMessage = (
	ref: SessionRef,
	message: Message,
): boolean => {
	const key = sessionTimelineResourceKey(ref);
	// Cloud launches stage their durable chat before any transcript consumer is
	// mounted. Materialize the canonical cell so their first optimistic message
	// is not discarded during that handoff.
	rendererClientBus.snapshot(key);
	return rendererClientBus.overlay(key, {
		initialData: emptyTimelineProjection(),
		update: (projection) => {
			const index = projection.messages.findIndex(
				(candidate) => candidate.id === message.id,
			);
			if (index === -1) {
				return SessionTimelineProjection.make({
					...projection,
					messages: [...projection.messages, message],
				});
			}
			const messages = [...projection.messages];
			messages[index] = message;
			return SessionTimelineProjection.make({ ...projection, messages });
		},
	});
};

const waitForTimelineHydration = async (
	bus: ClientBus<MemoizeClient>,
	key: SessionTimelineResourceKey,
): Promise<void> => {
	if (bus.snapshot(key).sync !== "hydrating-cache") return;
	await new Promise<void>((resolve) => {
		const unsubscribe = bus.subscribe(key, (view) => {
			if (view.sync === "hydrating-cache") return;
			unsubscribe();
			resolve();
		});
	});
};

export const restoreDurableOptimisticSessionMessages = async (
	ref: SessionRef,
	bus: ClientBus<MemoizeClient> = rendererClientBus,
): Promise<void> => {
	const key = sessionTimelineResourceKey(ref);
	await waitForTimelineHydration(bus, key);
	const entries = await commandOutbox.listOutbox(ref.environmentId);
	for (const entry of entries) {
		const message = durableOptimisticSessionMessage(entry, ref);
		if (message === null) continue;
		let sawPending = false;
		let unsubscribe: () => void = () => undefined;
		const reconcileSettlement = (
			view: ResourceView<SessionTimelineProjection>,
		): void => {
			const pending = view.pendingCommands.some(
				(command) => command.commandId === entry.command.commandId,
			);
			sawPending ||= pending;
			const failure = view.failedCommands.find(
				(command) => command.commandId === entry.command.commandId,
			);
			if (failure !== undefined && !failure.retryable) {
				unsubscribe();
				bus.overlay(key, {
					update: (projection) =>
						SessionTimelineProjection.make({
							...projection,
							messages: projection.messages.filter(
								(candidate) => candidate.id !== message.id,
							),
						}),
				});
				return;
			}
			if (sawPending && !pending && failure === undefined) unsubscribe();
		};
		bus.overlay(key, {
			initialData: emptyTimelineProjection(),
			update: (projection) => {
				if (
					projection.messages.some((candidate) => candidate.id === message.id)
				)
					return undefined;
				return SessionTimelineProjection.make({
					...projection,
					messages: [...projection.messages, message],
				});
			},
		});
		unsubscribe = bus.subscribe(key, reconcileSettlement);
		reconcileSettlement(bus.snapshot(key));
	}
};

const scheduleDurableOptimisticSessionMessageRestoration = (
	ref: SessionRef,
	bus: ClientBus<MemoizeClient>,
): void => {
	const id = resourceKeyId(sessionTimelineResourceKey(ref));
	if (optimisticRestorationByResource.has(id)) return;
	const restoration = restoreDurableOptimisticSessionMessages(ref, bus).catch(
		() => undefined,
	);
	optimisticRestorationByResource.set(id, restoration);
};

export const removeOptimisticSessionMessage = (
	ref: SessionRef,
	messageId: Message["id"],
): boolean =>
	rendererClientBus.overlay(sessionTimelineResourceKey(ref), {
		update: (projection) =>
			SessionTimelineProjection.make({
				...projection,
				messages: projection.messages.filter(
					(message) => message.id !== messageId,
				),
			}),
	});

/** Applies an optimistic queue projection; durable events reconcile by queue id. */
export const updateOptimisticSessionQueue = (
	ref: SessionRef,
	update: (
		queue: SessionTimelineProjection["queue"],
	) => SessionTimelineProjection["queue"],
): boolean =>
	rendererClientBus.overlay(sessionTimelineResourceKey(ref), {
		initialData: emptyTimelineProjection(),
		update: (projection) =>
			SessionTimelineProjection.make({
				...projection,
				queue: update(projection.queue),
			}),
	});

/** Restarts a retained provisional timeline after its session is acknowledged. */
export const restartSessionTimeline = (ref: SessionRef): boolean =>
	rendererClientBus.restart(sessionTimelineResourceKey(ref));

/**
 * Repairs the creation race where an optimistic timeline exists before the
 * durable session, but the creation acknowledgement tries to restart it before
 * ChatView has retained a live driver. Calling this from the mounted consumer
 * guarantees the resource has an owner; a real snapshot cursor makes the
 * operation a no-op on ordinary chat mounts.
 */
export const restartProvisionalSessionTimeline = (
	ref: SessionRef,
	view: ResourceView<SessionTimelineProjection>,
): boolean => {
	if (view.data === null || view.cursor !== null) return false;
	return restartSessionTimeline(ref);
};

export const retainSessionTimeline = (
	ref: SessionRef,
	activation: ResourceActivation,
): Readonly<{
	key: SessionTimelineResourceKey;
	lease: ResourceLease;
}> => {
	const key = sessionTimelineResourceKey(ref);
	const bus = rendererClientBus;
	const lease = bus.retain(key, { activation });
	scheduleDurableOptimisticSessionMessageRestoration(ref, bus);
	return {
		key,
		lease,
	};
};

const EMPTY_TIMELINE_VIEW: ResourceView<SessionTimelineProjection> = {
	data: null,
	origin: "none",
	connection: "dormant",
	sync: "empty",
	generation: 0,
	cursor: null,
	pendingCommands: [],
	failedCommands: [],
};

/**
 * React selector for the canonical qualified timeline resource. Retaining is
 * reference-counted by ClientBus, so chat, composer, sidebar, and dock readers
 * share one stream and one cursor instead of copying server entities into
 * feature stores.
 */
export const useSessionTimelineResource = (
	ref: SessionRef | null,
	activation: ResourceActivation = "connect",
): ResourceView<SessionTimelineProjection> => {
	const key = useMemo(
		() =>
			ref === null || ref.sessionId === "draft-session"
				? null
				: sessionTimelineResourceKey(ref),
		[ref?.environmentId, ref?.sessionId],
	);
	const bus = getRendererClientBus();
	useEffect(() => {
		if (key === null) return;
		const lease = bus.retain(key, { activation });
		const qualifiedRef = sessionRef(key);
		if (qualifiedRef !== null)
			scheduleDurableOptimisticSessionMessageRestoration(qualifiedRef, bus);
		return lease.release;
	}, [activation, bus, key]);
	const subscribe = useCallback(
		(listener: () => void) =>
			key === null ? () => undefined : bus.subscribe(key, listener),
		[bus, key],
	);
	const snapshot = useCallback(
		() => (key === null ? EMPTY_TIMELINE_VIEW : bus.snapshot(key)),
		[bus, key],
	);
	return useSyncExternalStore(subscribe, snapshot, snapshot);
};

export const setSessionTimelineRpcClientForTest = (
	resolve: (environmentId: EnvironmentId) => Promise<MemoizeClient>,
	release: (environmentId: EnvironmentId) => Promise<void> = async () =>
		undefined,
): void => {
	resolveRendererSession = async (environmentId) => ({
		client: await resolve(environmentId),
		dispose: () => release(environmentId),
	});
};

export const setSessionTimelineRpcSessionForTest = (
	resolve: ResolveRendererSession,
): void => {
	resolveRendererSession = resolve;
};

export const registerEnvironmentActivationForTest =
	registerEnvironmentActivation;

export const retryRendererEnvironmentConnection = (
	environmentId: EnvironmentId,
): void => {
	getRendererClientBus().retryConnection(environmentId);
};

export const resetSessionTimelineClientBus = async (): Promise<void> => {
	await rendererClientBus.dispose();
	rendererClientBus = createBus();
	optimisticRestorationByResource.clear();
	olderSessionMessageLoads.clear();
	checkpointSynchronizers.clear();
	olderPageSynchronizers.clear();
	activationByEnvironment.clear();
};

export const resetSessionTimelineClientBusForTest = (): void => {
	void rendererClientBus?.dispose();
	resetMemoryCommandOutboxForTest();
	commandOutbox = createClientCommandOutbox();
	rendererClientBus = createBus();
	optimisticRestorationByResource.clear();
	olderSessionMessageLoads.clear();
	activationByEnvironment.clear();
	resolveRendererSession = defaultResolveRendererSession;
};
