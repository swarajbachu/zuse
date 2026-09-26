import type { ExtensionListItem, ExtensionManifest } from "@zuse/contracts";
import type { ExtensionRegistrationCollector } from "@zuse/extension-sdk/host";
import { Schema } from "effect";
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as ReactDom from "react-dom";
import {
	boundedCleanup,
	emptyCollector,
	withExtensionDeadline,
} from "./extension-client-lifecycle.ts";
import type { ActiveRegistration } from "./extension-registry.tsx";

const LOCAL_ID = /^[a-z][a-z0-9-]{0,62}$/;
export async function evaluateExtension(
	item: ExtensionListItem & { readonly clientBundle: string },
): Promise<ActiveRegistration> {
	// The official panel SDK is optional; disabled previews should not load it.
	const [
		ExtensionSdkClient,
		UiDither,
		ExtensionSdk,
		{ createExtensionClientRuntime },
		HugeIconsReact,
		UiButton,
		UiCard,
		UiCode,
	] = await withExtensionDeadline(
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
		5000,
		"Extension client SDK loading timed out.",
	);
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
	const exports = (factory as (require: (name: string) => unknown) => unknown)(
		requireModule,
	);
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
		if (
			contributions.commands.length > 0 &&
			!item.grantedCapabilities.includes("commands")
		)
			throw new Error(
				"Command contributions require the commands capability grant.",
			);
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
	if (
		collector.commands.length > 0 &&
		!manifest.capabilities.includes("commands")
	)
		throw new Error(
			"Command contributions require the commands capability declaration.",
		);
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
