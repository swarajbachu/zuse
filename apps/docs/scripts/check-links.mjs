import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

const root = new URL("../content/docs/", import.meta.url);

async function walk(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = await Promise.all(
		entries.map((entry) => {
			const path = join(directory, entry.name);
			return entry.isDirectory() ? walk(path) : path;
		}),
	);
	return files.flat();
}

function routeFor(path) {
	const file = relative(root.pathname, path).split(sep).join("/");
	const route = file.replace(/\.(md|mdx)$/u, "").replace(/\/index$/u, "");
	return `/${route}`.replace(/\/$/u, "") || "/";
}

const files = (await walk(root.pathname)).filter((path) =>
	[".md", ".mdx"].includes(extname(path)),
);
const routes = new Map(files.map((path) => [routeFor(path), path]));
const failures = [];

if (routes.size !== files.length)
	failures.push("Duplicate documentation routes detected");

for (const path of files) {
	const source = await readFile(path, "utf8");
	const frontmatter = source.match(/^---\n([\s\S]*?)\n---/u)?.[1] ?? "";
	const body = source.replace(/^---\n[\s\S]*?\n---/u, "");
	const localLinks = [
		...body.matchAll(/\]\((\/[^)\s#]+)(?:#[^)]+)?\)/gu),
		...frontmatter.matchAll(/["'](\/[^"'#]+)(?:#[^"']+)?["']/gu),
	].map((match) => match[1].replace(/\/$/u, "") || "/");

	for (const target of localLinks) {
		if (!routes.has(target)) {
			failures.push(`${routeFor(path)} links to missing route ${target}`);
		}
	}

	if (/^# /mu.test(body))
		failures.push(`${routeFor(path)} repeats its page title as a body H1`);
}

if (failures.length > 0) {
	console.error(failures.join("\n"));
	process.exitCode = 1;
} else {
	console.log(
		`Validated ${routes.size} documentation routes and their internal links.`,
	);
}
