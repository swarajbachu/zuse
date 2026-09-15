import {
	EnvironmentId,
	type ExtensionCapability,
	SessionId,
} from "@zuse/contracts";
import type { ExtensionClientHost } from "@zuse/extension-sdk";
import { latestProposedPlanMarkdown } from "@zuse/utils/proposed-plan";
import { useEffect, useMemo } from "react";
import { useChatsStore } from "../store/chats.ts";
import { useEnvironmentCatalogStore } from "../store/environment-catalog.ts";
import { useSessionsStore } from "../store/sessions.ts";
import { useWorktreesStore } from "../store/worktrees.ts";
import { environmentShellData } from "./environment-entities.ts";
import { useEnvironmentShellResource } from "./environment-shell-client-bus.ts";
import { attachExtensionSnapshot } from "./extension-composer.ts";
import { useGitWorkspaceResource } from "./git-workspace-client-bus.ts";
import { getLocalEnvironmentId } from "./rpc-client.ts";
import { useSessionTimelineResource } from "./session-timeline-client-bus.ts";

// All extensions share the existing stores and keyed Git resources. No credential
// reads, provider polling loops, or unqualified cross-environment entity lookups.
const localId = () => EnvironmentId.make(getLocalEnvironmentId());
export const createExtensionDesktopHost = (
	capabilities: ReadonlyArray<ExtensionCapability>,
): ExtensionClientHost => {
	const requireCapability = (capability: ExtensionCapability) => {
		if (!capabilities.includes(capability))
			throw new Error(`Extension requires the ${capability} capability.`);
	};
	return {
		useSessions() {
			requireCapability("sessions");
			const view = useEnvironmentShellResource(localId(), "connect");
			const sessions = useMemo(() => {
				const data = view.data;
				if (!data) return [];
				return Object.values(data.sessionsByProject)
					.flat()
					.filter((s) => s.archivedAt === null)
					.map((s) => ({
						id: s.id,
						projectId: s.projectId,
						projectName:
							data.folders.find((p) => p.id === s.projectId)?.name ??
							s.projectId,
						title: s.title,
						providerId: s.providerId,
						model: s.model,
						status: s.status,
						updatedAt: s.updatedAt.toISOString(),
					}));
			}, [view.data]);
			return {
				sessions,
				loading: view.data === null && view.sync !== "failed",
				stale: view.sync !== "live" || view.connection !== "connected",
				error:
					view.sync === "failed" || view.connection === "failed"
						? "Could not load local agent sessions. Reconnect Zuse to retry."
						: null,
			};
		},
		usePullRequest(sessionId) {
			requireCapability("sessions");
			const shell = useEnvironmentShellResource(localId(), "connect");
			const activeEnvironment = useEnvironmentCatalogStore(
				(s) => s.activeEnvironmentId,
			);
			const session = Object.values(shell.data?.sessionsByProject ?? {})
				.flat()
				.find((s) => s.id === sessionId);
			const folder = shell.data?.folders.find(
				(f) => f.id === session?.projectId,
			);
			const worktrees = useWorktreesStore((s) => s.byProject);
			const worktreeError = useWorktreesStore((s) => s.error);
			const projectId = session?.projectId;
			const worktreeId = session?.worktreeId;
			const needsWorktrees =
				worktreeId != null &&
				projectId !== undefined &&
				worktrees[projectId] === undefined;
			useEffect(() => {
				if (
					activeEnvironment === getLocalEnvironmentId() &&
					needsWorktrees &&
					projectId !== undefined &&
					!useWorktreesStore.getState().loading.has(projectId)
				) {
					void useWorktreesStore.getState().refresh(projectId);
				}
			}, [activeEnvironment, needsWorktrees, projectId]);
			const worktree =
				projectId === undefined
					? undefined
					: worktrees[projectId]?.find((w) => w.id === worktreeId);
			const rootPath = worktreeId == null ? folder?.path : worktree?.path;
			const ref =
				folder && rootPath && activeEnvironment === getLocalEnvironmentId()
					? {
							environmentId: localId(),
							folderId: folder.id,
							worktreeId: worktreeId ?? null,
							rootPath,
						}
					: null;
			const view = useGitWorkspaceResource(ref, "connect");
			const pr = view.data?.pr;
			const unavailable =
				activeEnvironment !== getLocalEnvironmentId()
					? "Select the local environment to view branch status."
					: needsWorktrees
						? worktreeError
						: !rootPath
							? "Workspace is unavailable."
							: null;
			return {
				loading:
					!unavailable &&
					(needsWorktrees || (view.data === null && view.sync !== "failed")),
				stale:
					view.sync !== "live" ||
					view.connection !== "connected" ||
					pr?.stale === true,
				error:
					unavailable ??
					(pr?.prCapability && pr.prCapability !== "available"
						? `PR status unavailable: ${pr.prCapability.replaceAll("_", " ")}.`
						: null) ??
					view.data?.error?.message ??
					(view.sync === "failed" ? "Could not load branch status." : null),
				branch: pr?.branch ?? view.data?.status?.branch ?? null,
				pullRequest: pr
					? {
							number: pr.number,
							url: pr.url,
							state: pr.state,
							isDraft: pr.isDraft,
							checksRunning: pr.checksRunning,
							checksPassing: pr.checksPassing,
							checksFailing: pr.checksFailing,
							checksTotal: pr.checksTotal,
						}
					: null,
			};
		},
		usePlanOutput(id) {
			requireCapability("planning");
			const view = useSessionTimelineResource(
				id ? { environmentId: localId(), sessionId: SessionId.make(id) } : null,
				"connect",
			);
			const messages = view.data?.messages ?? [];
			const lastUser = messages.findLastIndex((m) => m.role === "user");
			const turn = messages.slice(lastUser + 1);
			const text =
				latestProposedPlanMarkdown(turn) ??
				turn
					.filter((m) => m.content._tag === "assistant")
					.map((m) => (m.content._tag === "assistant" ? m.content.text : ""))
					.join("\n");
			return {
				text: text.slice(0, 128 * 1024),
				truncated: text.length > 128 * 1024,
				stale: view.sync !== "live" || view.connection !== "connected",
			};
		},
		async preparePlan(id, instructions) {
			requireCapability("planning");
			if (
				useEnvironmentCatalogStore.getState().activeEnvironmentId !==
					getLocalEnvironmentId() ||
				useSessionsStore.getState().selectedSessionId !== id
			)
				throw new Error("Open the target local conversation first.");
			const session = Object.values(
				environmentShellData(localId())?.sessionsByProject ?? {},
			)
				.flat()
				.find((s) => s.id === id && s.archivedAt === null);
			if (session?.status !== "idle")
				throw new Error(
					"Wait for the agent to become idle before preparing a plan.",
				);
			if (!instructions.trim() || instructions.length > 16000)
				throw new Error("Plan instructions must contain 1–16,000 characters.");
			const changed = await useSessionsStore
				.getState()
				.setPermissionMode(session.id, "plan", localId());
			if (!changed)
				throw new Error(
					useSessionsStore.getState().error ??
						"This provider could not enter Plan mode.",
				);
			if (
				useSessionsStore.getState().selectedSessionId !== id ||
				useEnvironmentCatalogStore.getState().activeEnvironmentId !==
					getLocalEnvironmentId()
			)
				throw new Error(
					"Conversation changed. Return to it to attach the plan instructions.",
				);
			await attachExtensionSnapshot(id, {
				id: crypto.randomUUID(),
				title: "Visual plan instructions",
				text: instructions,
			});
		},
		async openSession(id) {
			requireCapability("sessions");
			if (
				useEnvironmentCatalogStore.getState().activeEnvironmentId !==
				getLocalEnvironmentId()
			)
				throw new Error(
					"Select the local environment before opening this session.",
				);
			const session = Object.values(
				environmentShellData(localId())?.sessionsByProject ?? {},
			)
				.flat()
				.find((s) => s.id === id && s.archivedAt === null);
			if (!session) throw new Error("This session is no longer available.");
			useChatsStore.getState().select(session.chatId);
			useSessionsStore.getState().select(SessionId.make(id));
			await useChatsStore
				.getState()
				.setActiveSession(session.chatId, session.id);
			window.dispatchEvent(new Event("zuse:extension-close-surface"));
		},
	};
};
