import { HOSTED_APP_URL } from "@zuse/contracts/deployment";

export const isHostedProduct = (
	locationOrigin = globalThis.window?.location?.origin ?? "",
): boolean =>
	import.meta.env?.VITE_ZUSE_HOSTED === "1" ||
	locationOrigin === HOSTED_APP_URL;

export type RendererPlatformCapabilities = {
	readonly desktop: boolean;
	readonly copyServerFile: boolean;
	readonly integratedBrowser: boolean;
	readonly nativeMenus: boolean;
	readonly networkLifecycle: boolean;
	readonly openInEditor: boolean;
	readonly revealInFileManager: boolean;
	readonly updater: boolean;
};

export const rendererPlatformCapabilities =
	(): RendererPlatformCapabilities => {
		const bridge = globalThis.window?.zuse ?? globalThis.window?.memoize;
		return {
			desktop: bridge !== undefined,
			copyServerFile: bridge?.app?.copyFileContents !== undefined,
			integratedBrowser: bridge?.browser !== undefined,
			nativeMenus: bridge?.menu !== undefined,
			networkLifecycle: bridge?.network !== undefined,
			openInEditor: bridge?.app?.openPathInApp !== undefined,
			revealInFileManager: bridge?.app?.revealPath !== undefined,
			updater: bridge?.updates !== undefined,
		};
	};

export const attachmentUrl = (id: string): string =>
	rendererPlatformCapabilities().desktop
		? `zuse://attachments/${encodeURIComponent(id)}`
		: `/assets/attachments/${encodeURIComponent(id)}`;

export const openExternal = async (
	url: string | (() => Promise<string>),
): Promise<void> => {
	const bridge = (globalThis.window?.zuse ?? globalThis.window?.memoize)?.app;
	if (bridge?.openExternal !== undefined) {
		await bridge.openExternal(typeof url === "string" ? url : await url());
		return;
	}
	if (typeof url !== "string") {
		const pending = window.open("", "_blank");
		if (pending === null) throw new Error("External window was blocked");
		pending.opener = null;
		try {
			const referrer = pending.document.createElement("meta");
			referrer.name = "referrer";
			referrer.content = "no-referrer";
			pending.document.head.append(referrer);
			const destination = await url();
			if (!pending.closed) pending.location.replace(destination);
		} catch (cause) {
			pending.close();
			throw cause;
		}
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

const copyTextWithSelection = (text: string): boolean => {
	if (globalThis.document?.body === undefined) return false;
	const input = document.createElement("textarea");
	input.value = text;
	input.setAttribute("readonly", "");
	input.style.position = "fixed";
	input.style.opacity = "0";
	document.body.append(input);
	input.select();
	input.setSelectionRange(0, text.length);
	const copied = document.execCommand("copy");
	input.remove();
	return copied;
};

export const copyImage = async (image: Blob): Promise<void> => {
	if (navigator.clipboard?.write === undefined) {
		throw new Error("Clipboard access is unavailable");
	}
	await navigator.clipboard.write([new ClipboardItem({ [image.type]: image })]);
};

export const copyText = async (text: string): Promise<void> => {
	const bridge = (globalThis.window?.zuse ?? globalThis.window?.memoize)?.app;
	if (bridge?.copyText !== undefined) {
		await bridge.copyText(text);
		return;
	}

	if (bridge !== undefined && copyTextWithSelection(text)) return;
	if (navigator.clipboard?.writeText === undefined) {
		if (copyTextWithSelection(text)) return;
		throw new Error("Clipboard access is unavailable");
	}
	try {
		await navigator.clipboard.writeText(text);
	} catch (cause) {
		if (!copyTextWithSelection(text)) throw cause;
	}
};
