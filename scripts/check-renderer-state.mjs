import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const renderer = join(root, "apps", "renderer");
const forbidden = /(?:from\s+["']zustand(?:\/[^"']*)?["']|["']zustand["']\s*:)/;
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".json"]);
const violations = [];

const visit = (path) => {
	for (const name of readdirSync(path)) {
		if (name === "dist" || name === "node_modules") continue;
		const child = join(path, name);
		if (statSync(child).isDirectory()) {
			visit(child);
			continue;
		}
		if (!extensions.has(extname(child))) continue;
		if (forbidden.test(readFileSync(child, "utf8"))) {
			violations.push(relative(root, child));
		}
	}
};

visit(renderer);
if (violations.length > 0) {
	console.error(
		`Renderer state must use Effect atoms:\n${violations.join("\n")}`,
	);
	process.exitCode = 1;
}
