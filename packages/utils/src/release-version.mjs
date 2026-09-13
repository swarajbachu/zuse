/** Versions supported by the desktop release channels. */
export function parseReleaseVersion(version) {
	const match =
		/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-preview\.([1-9]\d*))?$/.exec(
			version,
		);
	if (!match) throw new Error(`Invalid desktop release version: ${version}`);
	const numbers = match.slice(1, 4).map(Number);
	const preview = match[4] === undefined ? null : Number(match[4]);
	if (![...numbers, preview ?? 0].every(Number.isSafeInteger)) {
		throw new Error(`Release version exceeds safe integer range: ${version}`);
	}
	return { major: numbers[0], minor: numbers[1], patch: numbers[2], preview };
}

export function compareReleaseVersions(left, right) {
	const a = parseReleaseVersion(left);
	const b = parseReleaseVersion(right);
	return (
		a.major - b.major ||
		a.minor - b.minor ||
		a.patch - b.patch ||
		(a.preview === b.preview
			? 0
			: a.preview === null
				? 1
				: b.preview === null
					? -1
					: a.preview - b.preview)
	);
}

export function releaseMetadata(version) {
	const { preview } = parseReleaseVersion(version);
	return {
		version,
		tag: `v${version}`,
		channel: preview === null ? "stable" : "preview",
		updateChannel: preview === null ? "latest" : "preview",
		prerelease: preview !== null,
		name: `Zuse ${version}`,
	};
}

export function nextPreviewVersion(target, tags) {
	if (parseReleaseVersion(target).preview !== null)
		throw new Error("Target must be a Stable version");
	if (tags.includes(`v${target}`))
		throw new Error(`${target} is already released`);
	let last = 0;
	for (const tag of tags) {
		if (!tag.startsWith(`v${target}-preview.`)) continue;
		last = Math.max(last, parseReleaseVersion(tag.slice(1)).preview ?? 0);
	}
	const version = `${target}-preview.${last + 1}`;
	parseReleaseVersion(version);
	return version;
}
