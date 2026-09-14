import "@zuse/i18n/english/extensions";
import type {
	ExtensionCatalog,
	ExtensionId,
	ExtensionListItem,
	ExtensionManifest,
} from "@zuse/contracts";
import type { ExtensionRegistrationCollector } from "@zuse/extension-sdk/host";
import { useMessages as useExtensionMessages } from "@zuse/i18n/react";
import { Schema } from "effect";
import * as React from "react";
import { useEffect, useSyncExternalStore } from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import { useExtensionCatalog } from "./extension-client-bus.ts";

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
		const [
			ExtensionSdkClient,
			UiDither,
			ExtensionSdk,
			{ createExtensionClientRuntime },
			HugeIconsReact,
			UiButton,
			UiCard,
			UiCode,
		] = await Promise.race([
			Promise.all([
				import("@zuse/extension-sdk/client"),
				import("@repo/ui/dither"),
				import("@zuse/extension-sdk"),
				import("@zuse/extension-sdk/host"),
				import("@hugeicons/react"),
				import("@repo/ui/button"),
				import("@repo/ui/card"),
				import("@repo/ui/code"),
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
		const { createExtensionDesktopHost } = await import(
			"./extension-desktop-host.ts"
		);
		const clientRuntime = createExtensionClientRuntime(
			contributions,
			createExtensionDesktopHost(item.grantedCapabilities),
		);
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
			? (this.props.fallback ?? <ExtensionFailureMessage />)
			: this.props.children;
	}
}

function ExtensionFailureMessage() {
	const { message } = useExtensionMessages(["extensions"]);
	return (
		<p className="p-3 text-xs text-destructive">
			{message("extensions:failed")}
		</p>
	);
}
