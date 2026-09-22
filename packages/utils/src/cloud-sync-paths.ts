/** Shared by transfer filters and watcher signals: excluded writes must not postpone sync. */
export const CLOUD_SYNC_MARKER_FILE = ".zuse-sync.json";
export const CLOUD_SYNC_GENERATED_DIRECTORIES = [
	"node_modules",
	".cache",
	".turbo",
	".next/cache",
	"__pycache__",
	".pytest_cache",
	".zuse-rsync-partial",
] as const;

const excludedDirectories = [".git", ...CLOUD_SYNC_GENERATED_DIRECTORIES].map(
	(path) => `/${path}/`,
);

export const isCloudSyncExcludedPath = (path: string): boolean => {
	const normalized = path.replaceAll("\\", "/").replace(/^\.\//u, "");
	const wrapped = `/${normalized}/`;
	return (
		normalized.split("/").includes(CLOUD_SYNC_MARKER_FILE) ||
		excludedDirectories.some((directory) => wrapped.includes(directory))
	);
};

/** Slash-containing rsync patterns need an explicit prefix to match nested projects. */
export const cloudSyncRsyncDirectoryPattern = (path: string): string =>
	path.includes("/") ? `**/${path}` : path;
