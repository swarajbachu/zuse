import type { ExtensionRegistrationCollector } from "@zuse/extension-sdk/host";
export async function withExtensionDeadline<T>(
	operation: Promise<T>,
	timeoutMs: number,
	message: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(message)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
export const boundedCleanup = (dispose: () => Promise<void>) =>
	withExtensionDeadline(
		Promise.resolve().then(dispose),
		2000,
		"Extension cleanup timed out.",
	);

export const emptyCollector = (): ExtensionRegistrationCollector => ({
	surfaces: [],
	sidebarItems: [],
	workspacePanels: [],
	commands: [],
	themes: [],
	timelineTransformers: [],
	timelineRenderers: [],
	attachmentSources: [],
});
