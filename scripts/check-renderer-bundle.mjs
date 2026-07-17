import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const dist = resolve(import.meta.dirname, "../apps/renderer/dist");
const html = readFileSync(resolve(dist, "index.html"), "utf8");
const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?]+\.(?:js|css))"/g)]
	.map((match) => match[1])
	.filter((asset, index, all) => all.indexOf(asset) === index);

const totals = { js: 0, css: 0 };
for (const asset of assets) {
	const kind = asset.endsWith(".css") ? "css" : "js";
	totals[kind] += gzipSync(readFileSync(resolve(dist, asset))).byteLength;
}

const budgets = { js: 500 * 1024, css: 100 * 1024 };
for (const kind of ["js", "css"]) {
	const kib = (totals[kind] / 1024).toFixed(1);
	const limit = budgets[kind] / 1024;
	console.log(`initial ${kind}: ${kib} KiB gzip (budget ${limit} KiB)`);
	if (totals[kind] > budgets[kind]) process.exitCode = 1;
}

if (process.exitCode) {
	console.error(
		`Renderer bundle budget exceeded for ${basename(dirname(dist))}.`,
	);
}
