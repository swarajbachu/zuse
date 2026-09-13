import * as HugeIconsReact from "@hugeicons/react";
import * as UiButton from "@repo/ui/button";
import * as UiCard from "@repo/ui/card";
import * as UiCode from "@repo/ui/code";
import type {
	ExtensionCatalog,
	ExtensionId,
	ExtensionListItem,
	ExtensionManifest,
} from "@zuse/contracts";
import * as ExtensionSdk from "@zuse/extension-sdk";
import {
	createExtensionClientRuntime,
	type ExtensionRegistrationCollector,
} from "@zuse/extension-sdk/host";
import { Schema } from "effect";
import * as React from "react";
import { useEffect, useState, useSyncExternalStore } from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import { useActiveContext } from "../store/active-workspace.ts";
import { useUiStore } from "../store/ui.ts";
import {
	extensionActions,
	useExtensionCatalog,
} from "./extension-client-bus.ts";
import { attachExtensionSnapshot } from "./extension-composer.ts";
import { getLocalEnvironmentId } from "./rpc-client.ts";

export interface RegisteredExtension {
	readonly extensionId: ExtensionId;
	readonly contributions: ExtensionRegistrationCollector;
	readonly error: string | null;
}

interface ActiveRegistration extends RegisteredExtension {
	readonly bundle: string;
	readonly dispose: () => Promise<void>;
}

const EMPTY: ReadonlyArray<RegisteredExtension> = [];
const boundedCleanup = async (dispose: () => Promise<void>) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			dispose(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Extension cleanup timed out.")),
					2000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
};
const LOCAL_ID = /^[a-z][a-z0-9-]{0,62}$/;

class ExtensionRegistry {
	private active = new Map<ExtensionId, ActiveRegistration>();
	private snapshot: ReadonlyArray<RegisteredExtension> = EMPTY;
	private listeners = new Set<() => void>();
	private revision = Promise.resolve();

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): ReadonlyArray<RegisteredExtension> => this.snapshot;

	sync(catalog: ExtensionCatalog): void {
		this.revision = this.revision.then(
			() => this.apply(catalog),
			() => this.apply(catalog),
		);
	}

	private async apply(catalog: ExtensionCatalog): Promise<void> {
		const desired = new Map(
			catalog.items
				.filter(
					(item) => item.status === "running" && item.clientBundle !== null,
				)
				.map((item) => [item.id, item] as const),
		);
		for (const [id, registration] of this.active) {
			const item = desired.get(id);
			if (item?.clientBundle === registration.bundle) continue;
			try {
				await boundedCleanup(registration.dispose);
			} catch (cause) {
				console.error("[extensions] cleanup failed", cause);
			} finally {
				this.active.delete(id);
			}
		}
		for (const [id, item] of desired) {
			if (this.active.has(id) || item.clientBundle === null) continue;
			const runnableItem = { ...item, clientBundle: item.clientBundle };
			try {
				this.active.set(id, await this.evaluate(runnableItem));
			} catch (cause) {
				console.error(`[extensions] client setup failed: ${id}`, cause);
				this.active.set(id, {
					extensionId: id,
					bundle: item.clientBundle,
					contributions: emptyCollector(),
					error: cause instanceof Error ? cause.message : String(cause),
					dispose: async () => {},
				});
			}
		}
		this.snapshot = [...this.active.values()].sort((left, right) =>
			left.extensionId.localeCompare(right.extensionId),
		);
		for (const listener of this.listeners) listener();
	}

	private async evaluate(
		item: ExtensionListItem & { readonly clientBundle: string },
	): Promise<ActiveRegistration> {
		// The official panel SDK is optional; disabled previews should not load it.
		let sdkTimer: ReturnType<typeof setTimeout> | undefined;
		const [ExtensionSdkClient, UiDither] = await Promise.race([
			Promise.all([
				import("@zuse/extension-sdk/client"),
				import("@repo/ui/dither"),
			]),
			new Promise<never>((_, reject) => {
				sdkTimer = setTimeout(
					() => reject(new Error("Extension client SDK loading timed out.")),
					5000,
				);
			}),
		]).finally(() => clearTimeout(sdkTimer));
		const extensionId = item.id;
		const bundle = item.clientBundle;
		const contributions = emptyCollector();
		const requireModule = (name: string): unknown => {
			if (name === "react") return React;
			if (name === "react/jsx-runtime") return JsxRuntime;
			if (name === "react-dom") return ReactDom;
			if (name === "effect") return { Schema };
			if (name === "@hugeicons/react") return HugeIconsReact;
			if (name === "@repo/ui/button") return UiButton;
			if (name === "@repo/ui/card") return UiCard;
			if (name === "@repo/ui/code") return UiCode;
			if (name === "@repo/ui/dither") return UiDither;
			if (name === "@zuse/extension-sdk/client") return ExtensionSdkClient;
			if (name === "@zuse/extension-sdk") {
				return { ...ExtensionSdk, extensionTarget: "client" as const };
			}
			throw new Error(`Extension client module is not allowlisted: ${name}`);
		};
		// Extensions are explicitly trusted renderer code. The compiler emits a
		// factory expression so the host can supply only its allowlisted modules.
		// biome-ignore lint/security/noGlobalEval: trusted extension factory boundary
		const factory = (globalThis.eval as (source: string) => unknown)(bundle);
		if (typeof factory !== "function")
			throw new Error("Client bundle is not executable.");
		const exports = (
			factory as (require: (name: string) => unknown) => unknown
		)(requireModule);
		const setup =
			exports && typeof exports === "object"
				? Reflect.get(exports, "default")
				: null;
		if (typeof setup !== "function")
			throw new Error("Extension client must default export setup().");
		const clientRuntime = createExtensionClientRuntime(contributions);
		let cleanup: () => unknown;
		try {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let expired = false;
			const preparation = Promise.resolve().then(() =>
				setup(clientRuntime.context),
			);
			void preparation.then(
				(value) => {
					if (expired && typeof value === "function")
						void boundedCleanup(async () => {
							await value();
						}).catch(() => {});
				},
				() => {},
			);
			let candidate: unknown;
			try {
				candidate = await Promise.race([
					preparation,
					new Promise((_, reject) => {
						timer = setTimeout(() => {
							expired = true;
							reject(new Error("Extension client setup timed out."));
						}, 5000);
					}),
				]);
			} finally {
				if (timer) clearTimeout(timer);
			}
			if (typeof candidate !== "function")
				throw new Error("Extension setup must return cleanup().");
			cleanup = () => candidate();
		} catch (cause) {
			clientRuntime.dispose();
			throw cause;
		}
		try {
			validateContributions(contributions, item.manifest);
		} catch (cause) {
			clientRuntime.dispose();
			void boundedCleanup(async () => {
				await cleanup();
			}).catch(() => {});
			throw cause;
		}
		const style = document.createElement("style");
		style.dataset.zuseExtension = extensionId;
		style.textContent = item.clientCss;
		document.head.append(style);
		return {
			extensionId,
			bundle,
			contributions,
			error: null,
			dispose: async () => {
				style.remove();
				clientRuntime.dispose();
				try {
					await cleanup();
				} finally {
					clientRuntime.dispose();
				}
			},
		};
	}
}

const emptyCollector = (): ExtensionRegistrationCollector => ({
	surfaces: [],
	sidebarItems: [],
	workspacePanels: [],
	commands: [],
	themes: [],
	timelineTransformers: [],
	timelineRenderers: [],
	attachmentSources: [],
});

const validateContributions = (
	collector: ExtensionRegistrationCollector,
	manifest: ExtensionManifest,
): void => {
	const groups: ReadonlyArray<
		ReadonlyArray<{ readonly id?: string; readonly kind?: string }>
	> = [
		collector.surfaces,
		collector.sidebarItems,
		collector.workspacePanels,
		collector.commands,
		collector.themes,
		collector.timelineTransformers,
		collector.timelineRenderers,
		collector.attachmentSources,
	];
	for (const group of groups) {
		const ids = new Set<string>();
		for (const item of group) {
			const id = item.id ?? item.kind;
			if (id === undefined || !LOCAL_ID.test(id))
				throw new Error(`Invalid contribution ID: ${id ?? "missing"}`);
			if (ids.has(id)) throw new Error(`Duplicate contribution ID: ${id}`);
			ids.add(id);
		}
	}
	const declarations = new Set(manifest.contributions);
	const required = [
		[collector.surfaces.length, "surface"],
		[collector.sidebarItems.length, "sidebar-item"],
		[collector.workspacePanels.length, "workspace-panel"],
		[collector.commands.length, "command"],
		[collector.themes.length, "theme"],
		[collector.timelineTransformers.length, "timeline-transformer"],
		[collector.timelineRenderers.length, "timeline-renderer"],
		[collector.attachmentSources.length, "attachment-source"],
	] as const;
	for (const [count, declaration] of required) {
		if (count > 0 && !declarations.has(declaration)) {
			throw new Error(
				`Extension registered undeclared contribution: ${declaration}`,
			);
		}
	}
	if (
		collector.surfaces.length +
			collector.sidebarItems.length +
			collector.workspacePanels.length >
			0 &&
		!manifest.capabilities.includes("ui")
	) {
		throw new Error("UI contributions require the ui capability.");
	}
};

export const extensionRegistry = new ExtensionRegistry();

const EMPTY_EXTENSION_CONTRIBUTIONS: ReadonlyArray<RegisteredExtension> = [];

export const useExtensionContributions =
	(): ReadonlyArray<RegisteredExtension> =>
		useSyncExternalStore(
			extensionRegistry.subscribe,
			extensionRegistry.getSnapshot,
			() => EMPTY_EXTENSION_CONTRIBUTIONS,
		);

export function ExtensionHostController() {
	const { items, globallyEnabled } = useExtensionCatalog();
	useEffect(
		() => extensionRegistry.sync({ items, globallyEnabled }),
		[items, globallyEnabled],
	);
	return null;
}

export const extensionHostTheme = {
	colors: {
		background: "var(--background)",
		foreground: "var(--foreground)",
		card: "var(--card)",
		cardForeground: "var(--card-foreground)",
		popover: "var(--popover)",
		popoverForeground: "var(--popover-foreground)",
		muted: "var(--muted)",
		mutedForeground: "var(--muted-foreground)",
		border: "var(--border)",
		input: "var(--input)",
		accent: "var(--accent)",
		accentForeground: "var(--accent-foreground)",
		destructive: "var(--destructive)",
		ring: "var(--ring)",
	},
} as const;

export function ExtensionSurfaceHost() {
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
		window.addEventListener("zuse:extension-open-surface", surface);
		window.addEventListener("zuse:extension-open-workspace-panel", panel);
		return () => {
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
					Close
				</button>
			</header>
			<ExtensionErrorBoundary extensionId={extension.extensionId}>
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
				Select a ready local workspace to use this extension.
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
				This extension panel is unavailable.
			</div>
		);
	}
	return (
		<ExtensionErrorBoundary extensionId={extension.extensionId}>
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

export class ExtensionErrorBoundary extends React.Component<
	React.PropsWithChildren<{
		readonly extensionId: string;
		readonly fallback?: React.ReactNode;
	}>,
	{ readonly failed: boolean }
> {
	state = { failed: false };
	static getDerivedStateFromError() {
		return { failed: true };
	}
	override componentDidCatch(cause: unknown) {
		console.error(
			`[extension:${this.props.extensionId}] renderer contribution failed`,
			cause,
		);
	}
	override render() {
		return this.state.failed
			? (this.props.fallback ?? (
					<p className="p-3 text-xs text-destructive">Extension view failed.</p>
				))
			: this.props.children;
	}
}
