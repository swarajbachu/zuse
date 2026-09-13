import type { ComponentType } from "react";
import type {
	ExtensionAttachmentSourceContribution,
	ExtensionClientContext,
	ExtensionCommandContribution,
	ExtensionSidebarContribution,
	ExtensionSurfaceContribution,
	ExtensionSurfaceProps,
	ExtensionThemeContribution,
	ExtensionTimelineRendererContribution,
	ExtensionTimelineTransformerContribution,
	ExtensionWorkspacePanelContribution,
} from "./contracts.ts";

export interface ExtensionRegistrationCollector {
	readonly surfaces: ExtensionSurfaceContribution[];
	readonly sidebarItems: ExtensionSidebarContribution[];
	readonly workspacePanels: ExtensionWorkspacePanelContribution[];
	readonly commands: ExtensionCommandContribution[];
	readonly themes: ExtensionThemeContribution[];
	readonly timelineTransformers: ExtensionTimelineTransformerContribution[];
	readonly timelineRenderers: ExtensionTimelineRendererContribution<unknown>[];
	readonly attachmentSources: ExtensionAttachmentSourceContribution[];
}

export const createExtensionClientRuntime = (
	collector: ExtensionRegistrationCollector,
): {
	readonly context: ExtensionClientContext;
	readonly dispose: () => void;
} => {
	let disposed = false;
	const assertActive = () => {
		if (disposed) throw new Error("Extension client has been disposed.");
	};
	const values = new Map<string, unknown>();
	const listeners = new Set<() => void>();
	const publish = () => {
		for (const listener of listeners) listener();
	};
	const context: ExtensionClientContext = {
		target: "client",
		queryState: {
			get: <T>(key: string) => values.get(key) as T | undefined,
			set: <T>(key: string, value: T) => {
				assertActive();
				values.set(key, value);
				publish();
			},
			invalidate: (key?: string) => {
				if (key === undefined) values.clear();
				else values.delete(key);
				publish();
			},
			subscribe: (listener) => {
				assertActive();
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
		},
		addSurface(id: string, Component: ComponentType<ExtensionSurfaceProps>) {
			assertActive();
			collector.surfaces.push({ id, Component });
		},
		addSidebarItem(contribution) {
			assertActive();
			collector.sidebarItems.push(contribution);
		},
		addWorkspacePanel(contribution) {
			assertActive();
			collector.workspacePanels.push(contribution);
		},
		addCommand(contribution) {
			assertActive();
			collector.commands.push(contribution);
		},
		addTheme(contribution) {
			assertActive();
			collector.themes.push(contribution);
		},
		addTimelineTransformer(contribution) {
			assertActive();
			collector.timelineTransformers.push(contribution);
		},
		addTimelineRenderer(contribution) {
			assertActive();
			collector.timelineRenderers.push(
				contribution as ExtensionTimelineRendererContribution<unknown>,
			);
		},
		addAttachmentSource(contribution) {
			assertActive();
			collector.attachmentSources.push(contribution);
		},
	};
	return {
		context,
		dispose: () => {
			disposed = true;
			for (const collection of Object.values(collector)) collection.length = 0;
			values.clear();
			listeners.clear();
		},
	};
};

export const createExtensionClientContext = (
	collector: ExtensionRegistrationCollector,
): ExtensionClientContext => createExtensionClientRuntime(collector).context;
