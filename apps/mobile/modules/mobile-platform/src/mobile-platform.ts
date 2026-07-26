import { requireOptionalNativeModule } from "expo";

type NativeModule = {
	readonly presentQuickLook: (uri: string) => boolean;
	readonly beginBackgroundTask: () => Promise<number>;
	readonly endBackgroundTask: (id: number) => Promise<void>;
	readonly saveImageToPhotos: (uri: string) => Promise<boolean>;
};

const Native = requireOptionalNativeModule<NativeModule>("ZuseMobilePlatform");

export const presentQuickLook = (uri: string): boolean =>
	Native?.presentQuickLook(uri) === true;

export const beginBestEffortBackgroundTask = async (): Promise<number> =>
	(await Native?.beginBackgroundTask()) ?? 0;

export const endBestEffortBackgroundTask = async (
	id: number,
): Promise<void> => {
	if (id !== 0) await Native?.endBackgroundTask(id);
};

export const saveImageToPhotos = async (uri: string): Promise<boolean> =>
	(await Native?.saveImageToPhotos(uri)) === true;
