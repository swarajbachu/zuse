export function parseReleaseVersion(version: string): {
	major: number;
	minor: number;
	patch: number;
	preview: number | null;
};
export function compareReleaseVersions(left: string, right: string): number;
export function releaseMetadata(version: string): {
	version: string;
	tag: string;
	channel: "stable" | "preview";
	updateChannel: "latest" | "preview";
	prerelease: boolean;
	name: string;
};
export function nextPreviewVersion(
	target: string,
	tags: readonly string[],
): string;
