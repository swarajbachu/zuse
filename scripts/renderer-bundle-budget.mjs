const collectStaticAssets = (manifest, roots) => {
	const assets = new Set();
	const visited = new Set();
	const visit = (key) => {
		if (visited.has(key)) return;
		visited.add(key);
		const chunk = manifest[key];
		if (chunk === undefined) {
			throw new Error(`Renderer manifest is missing chunk ${key}`);
		}
		assets.add(chunk.file);
		for (const stylesheet of chunk.css ?? []) assets.add(stylesheet);
		for (const imported of chunk.imports ?? []) visit(imported);
	};
	for (const root of roots) visit(root);
	return [...assets].sort();
};

export const collectEntryAssets = (manifest, entry) =>
	collectStaticAssets(manifest, [entry]);

export const collectRouteAssets = (manifest, entry, routeSource) => {
	const route = Object.keys(manifest).find(
		(key) => key === routeSource || key.endsWith(`/${routeSource}`),
	);
	if (route === undefined) {
		throw new Error(`Renderer manifest is missing route ${routeSource}`);
	}
	return collectStaticAssets(manifest, [entry, route]);
};
