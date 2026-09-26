import { ExtensionErrorBoundary } from "./extension-error-boundary.tsx";
import "@zuse/i18n/english/extensions";
import { useMessages as useExtensionMessages } from "@zuse/i18n/react";
import { Schema } from "effect";
import * as React from "react";
import { useEffect, useState } from "react";
import { useActiveContext } from "../store/active-workspace.ts";
import { useUiStore } from "../store/ui.ts";
import { extensionActions } from "./extension-client-bus.ts";
import { attachExtensionSnapshot } from "./extension-composer.ts";
import {
	extensionHostTheme,
	useExtensionContributions,
} from "./extension-registry.tsx";
import { getLocalEnvironmentId } from "./rpc-client.ts";
export function ExtensionSurfaceHost() {
	const { message: extensionMessage } = useExtensionMessages(["extensions"]);
	const extensions = useExtensionContributions();
	const [open, setOpen] = useState<{
		readonly extensionId: string;
		readonly contributionId: string;
	} | null>(null);
	useEffect(() => {
		const surface = (event: Event) => {
			const detail = (
				event as CustomEvent<{ extensionId: string; surfaceId: string }>
			).detail;
			setOpen({
				extensionId: detail.extensionId,
				contributionId: detail.surfaceId,
			});
		};
		const panel = (event: Event) => {
			const detail = (
				event as CustomEvent<{ extensionId: string; panelId: string }>
			).detail;
			useUiStore.getState().openExtensionPanel({
				extensionId: detail.extensionId,
				panelId: detail.panelId,
			});
		};
		const close = () => setOpen(null);
		window.addEventListener("zuse:extension-close-surface", close);
		window.addEventListener("zuse:extension-open-surface", surface);
		window.addEventListener("zuse:extension-open-workspace-panel", panel);
		return () => {
			window.removeEventListener("zuse:extension-close-surface", close);
			window.removeEventListener("zuse:extension-open-surface", surface);
			window.removeEventListener("zuse:extension-open-workspace-panel", panel);
		};
	}, []);
	if (open === null) return null;
	const extension = extensions.find(
		(candidate) => candidate.extensionId === open.extensionId,
	);
	if (extension === undefined) return null;
	const surface = extension.contributions.surfaces.find(
		(candidate) => candidate.id === open.contributionId,
	);
	if (surface === undefined) return null;
	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground">
			<header className="flex h-8 shrink-0 items-center justify-between border-b border-border/40 px-3 text-xs">
				<span>{surface.id}</span>
				<button
					type="button"
					className="h-7 rounded-md px-2 text-muted-foreground hover:bg-muted"
					onClick={() => setOpen(null)}
				>
					{extensionMessage("extensions:close")}
				</button>
			</header>
			<ExtensionErrorBoundary
				key={`${extension.extensionId}:${surface.id}`}
				extensionId={extension.extensionId}
				resetKey={extension.contributions}
			>
				{React.createElement(surface.Component, {
					extensionId: extension.extensionId,
					theme: extensionHostTheme,
					layout: { compact: false, platform: "desktop" },
				})}
			</ExtensionErrorBoundary>
		</div>
	);
}

export function ExtensionWorkspacePanelHost({
	projectId,
	sessionId,
}: {
	readonly projectId: string | null;
	readonly workspacePath: string | null;
	readonly sessionId: string | null;
}) {
	const { message: extensionMessage } = useExtensionMessages(["extensions"]);
	const activeContext = useActiveContext();
	const extensions = useExtensionContributions();
	const panelRef = useUiStore((state) => state.extensionPanel);
	if (panelRef === null) return null;
	if (
		activeContext.status !== "ready" ||
		activeContext.worktreePending ||
		activeContext.environmentId !== getLocalEnvironmentId()
	)
		return (
			<p role="status" className="p-4 text-xs text-muted-foreground">
				{extensionMessage("extensions:workspace")}
			</p>
		);
	const extension = extensions.find(
		(candidate) => candidate.extensionId === panelRef.extensionId,
	);
	const panel = extension?.contributions.workspacePanels.find(
		(candidate) => candidate.id === panelRef.panelId,
	);
	if (extension === undefined || panel === undefined) {
		return (
			<div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
				{extensionMessage("extensions:unavailable")}
			</div>
		);
	}
	return (
		<ExtensionErrorBoundary
			key={`${extension.extensionId}:${panel.id}`}
			extensionId={extension.extensionId}
			resetKey={extension.contributions}
		>
			{React.createElement(panel.Component, {
				extensionId: extension.extensionId,
				theme: extensionHostTheme,
				layout: { compact: false, platform: "desktop" },
				projectId: projectId ?? "",
				workspacePath: activeContext.rootPath,
				sessionId,
				invoke: async <Input, Output>(
					contract: import("@zuse/extension-sdk").ExtensionRpcContract<
						Input,
						Output
					>,
					input: Input,
					options?: { signal?: AbortSignal },
				) => {
					options?.signal?.throwIfAborted();
					if (
						activeContext.status !== "ready" ||
						activeContext.environmentId !== getLocalEnvironmentId()
					)
						throw new Error("Select a local workspace first.");
					const result = await extensionActions.invoke(
						extension.extensionId,
						contract.name,
						Schema.decodeUnknownSync(contract.input)(input),
						{
							projectId: activeContext.folderId,
							worktreeId: activeContext.worktreeId,
							sessionId: activeContext.sessionId,
						},
						options?.signal,
					);
					options?.signal?.throwIfAborted();
					return Schema.decodeUnknownSync(contract.output)(result);
				},
				attach: (
					snapshot: import("@zuse/extension-sdk").ExtensionAttachmentSnapshot,
				) => attachExtensionSnapshot(sessionId, snapshot),
			})}
		</ExtensionErrorBoundary>
	);
}
