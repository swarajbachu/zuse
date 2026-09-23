import { useEffect, useSyncExternalStore } from "react";
import {
	DEFAULT_WALLPAPER_OPACITY,
	MAX_WALLPAPER_OPACITY,
	prepareWallpaper,
	WALLPAPER_PROCESSING_VERSION,
} from "./wallpaper-image";

type SavedWallpaper = {
	image: Blob;
	opacity: number;
	source?: Blob;
	processingVersion?: number;
};
type WallpaperState = {
	url: string | null;
	opacity: number;
	busy: boolean;
	loaded: boolean;
	error: string | null;
};
let state: WallpaperState = {
	url: null,
	opacity: DEFAULT_WALLPAPER_OPACITY,
	busy: false,
	loaded: false,
	error: null,
};
let saved: SavedWallpaper | null = null;
let loading: Promise<void> | undefined;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () => state;
const publish = (patch: Partial<WallpaperState>) => {
	state = { ...state, ...patch };
	for (const listener of listeners) listener();
};

// A device-local image belongs in blob storage, not remote settings or localStorage.
async function accessWallpaper(write?: {
	value: SavedWallpaper | null;
}): Promise<SavedWallpaper | null> {
	const database = await new Promise<IDBDatabase>((resolve, reject) => {
		let blocked = false;
		const request = indexedDB.open("zuse-wallpaper", 1);
		request.onupgradeneeded = () =>
			request.result.createObjectStore("wallpaper");
		request.onsuccess = () => {
			if (blocked) request.result.close();
			else resolve(request.result);
		};
		request.onerror = () => reject(request.error);
		request.onblocked = () => {
			blocked = true;
			reject(new Error("Close other Zuse windows and try again."));
		};
	});
	try {
		return await new Promise((resolve, reject) => {
			const transaction = database.transaction(
				"wallpaper",
				write ? "readwrite" : "readonly",
			);
			const store = transaction.objectStore("wallpaper");
			const request = write
				? write.value
					? store.put(write.value, "current")
					: store.delete("current")
				: store.get("current");
			transaction.oncomplete = () =>
				resolve(write ? write.value : (request.result ?? null));
			transaction.onabort = () =>
				reject(
					transaction.error ?? new Error("Wallpaper storage was interrupted."),
				);
			transaction.onerror = () =>
				reject(transaction.error ?? new Error("Wallpaper could not be saved."));
		});
	} finally {
		database.close();
	}
}

function apply(value: SavedWallpaper | null) {
	const oldUrl = state.url;
	const url = value
		? value.image === saved?.image
			? oldUrl
			: URL.createObjectURL(value.image)
		: null;
	saved = value;
	publish({
		url,
		opacity: value?.opacity ?? DEFAULT_WALLPAPER_OPACITY,
		loaded: true,
		error: null,
	});
	if (oldUrl && oldUrl !== url) URL.revokeObjectURL(oldUrl);
}

async function load() {
	if (!loading)
		loading = (async () => {
			try {
				const value = await accessWallpaper();
				if (
					value &&
					(!(value.image instanceof Blob) || !Number.isFinite(value.opacity))
				)
					throw new Error(
						"Saved wallpaper could not be read. Upload it again.",
					);
				if (!value) {
					apply(null);
					return;
				}
				const current = {
					...value,
					opacity: Math.max(0, Math.min(MAX_WALLPAPER_OPACITY, value.opacity)),
				};
				// Display the last saved image until its replacement commits. Keep the
				// original so future processing changes never dither an already-dithered copy.
				apply(current);
				if (current.processingVersion !== WALLPAPER_PROCESSING_VERSION) {
					publish({ loaded: false });
					const source = current.source ?? current.image;
					const migrated = {
						...current,
						source,
						image: await prepareWallpaper(source),
						processingVersion: WALLPAPER_PROCESSING_VERSION,
						opacity:
							current.opacity === 0.25
								? DEFAULT_WALLPAPER_OPACITY
								: current.opacity,
					};
					await accessWallpaper({ value: migrated });
					apply(migrated);
				}
			} catch {
				publish({
					loaded: true,
					error: "Could not load wallpaper. Try uploading it again.",
				});
			}
		})();
	await loading;
}

async function mutate(next: () => Promise<SavedWallpaper | null>) {
	if (state.busy) return;
	publish({ busy: true, error: null });
	try {
		await load();
		const value = await next();
		await accessWallpaper({ value });
		apply(value);
	} catch (error) {
		publish({
			error:
				error instanceof Error
					? error.message
					: "Could not save wallpaper. Please try again.",
		});
	} finally {
		publish({ busy: false });
	}
}

export const uploadWallpaper = (file: File) =>
	mutate(async () => ({
		source: file,
		image: await prepareWallpaper(file),
		processingVersion: WALLPAPER_PROCESSING_VERSION,
		opacity: saved?.opacity ?? DEFAULT_WALLPAPER_OPACITY,
	}));
export const removeWallpaper = () => mutate(async () => null);
export const setWallpaperOpacity = (opacity: number) =>
	mutate(async () =>
		saved
			? {
					...saved,
					opacity: Math.max(0, Math.min(MAX_WALLPAPER_OPACITY, opacity)),
				}
			: null,
	);

export function useWallpaper() {
	const value = useSyncExternalStore(subscribe, snapshot, snapshot);
	useEffect(() => {
		void load();
	}, []);
	return value;
}
