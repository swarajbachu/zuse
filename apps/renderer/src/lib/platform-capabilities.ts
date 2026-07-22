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

export const openExternal = async (url: string): Promise<void> => {
	const bridge = (globalThis.window?.zuse ?? globalThis.window?.memoize)?.app;
	if (bridge?.openExternal !== undefined) {
		await bridge.openExternal(url);
		return;
	}
	window.open(url, "_blank", "noopener,noreferrer");
};

export const copyText = async (text: string): Promise<void> => {
	if (navigator.clipboard?.writeText !== undefined) {
		await navigator.clipboard.writeText(text);
		return;
	}
	const bridge = (globalThis.window?.zuse ?? globalThis.window?.memoize)?.app;
	if (bridge?.copyPath !== undefined) await bridge.copyPath(text);
};
