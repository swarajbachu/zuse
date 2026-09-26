import type { ExtensionCatalog, ExtensionId } from "@zuse/contracts";
import type { ExtensionRegistrationCollector } from "@zuse/extension-sdk/host";
import { useEffect, useSyncExternalStore } from "react";
import { useExtensionCatalog } from "./extension-client-bus.ts";
import {
	boundedCleanup,
	emptyCollector,
	withExtensionDeadline,
} from "./extension-client-lifecycle.ts";

export interface RegisteredExtension {
	readonly extensionId: ExtensionId;
	readonly contributions: ExtensionRegistrationCollector;
	readonly error: string | null;
}

export interface ActiveRegistration extends RegisteredExtension {
	readonly bundle: string;
	readonly dispose: () => Promise<void>;
}

const EMPTY: ReadonlyArray<RegisteredExtension> = [];
export class ExtensionRegistry {
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
			if (item !== undefined) continue;
			try {
				await boundedCleanup(registration.dispose);
			} catch (cause) {
				console.error("[extensions] cleanup failed", cause);
			} finally {
				this.active.delete(id);
			}
		}
		for (const [id, item] of desired) {
			const previous = this.active.get(id);
			if (previous?.bundle === item.clientBundle || item.clientBundle === null)
				continue;
			const runnableItem = { ...item, clientBundle: item.clientBundle };
			try {
				const { evaluateExtension } = await withExtensionDeadline(
					import("./extension-evaluator.ts"),
					5000,
					"Extension client loading timed out.",
				);
				const candidate = await evaluateExtension(runnableItem);
				this.active.set(id, candidate);
				if (previous) {
					try {
						await boundedCleanup(previous.dispose);
					} catch (cause) {
						console.error("[extensions] cleanup failed", cause);
					}
				}
			} catch (cause) {
				console.error(`[extensions] client setup failed: ${id}`, cause);
				this.active.set(
					id,
					previous
						? {
								...previous,
								error: cause instanceof Error ? cause.message : String(cause),
							}
						: {
								extensionId: id,
								bundle: item.clientBundle,
								contributions: emptyCollector(),
								error: cause instanceof Error ? cause.message : String(cause),
								dispose: async () => {},
							},
				);
			}
		}
		this.snapshot = [...this.active.values()].sort((left, right) =>
			left.extensionId.localeCompare(right.extensionId),
		);
		for (const listener of this.listeners) listener();
	}
}

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
