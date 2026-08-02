export const MINIMUM_NODE_MAJOR = 22;

export const nodeMajorVersion = (version: string): number | null => {
	const [major] = version.replace(/^v/u, "").split(".");
	if (major === undefined || !/^\d+$/u.test(major)) return null;
	return Number(major);
};

export const assertSupportedNodeVersion = (
	version: string = process.versions.node,
): void => {
	const major = nodeMajorVersion(version);
	if (major !== null && major >= MINIMUM_NODE_MAJOR) return;
	throw new Error(
		`Zuse requires Node.js ${MINIMUM_NODE_MAJOR} or newer (current: ${version}). Install a current Node.js LTS release, then run \`npx zusehq serve\` again.`,
	);
};
