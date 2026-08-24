import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import {
	collectEntryAssets,
	collectRouteAssets,
} from "./renderer-bundle-budget.mjs";

const dist = resolve(import.meta.dirname, "../apps/renderer/dist");
const expectedAnalyticsKey = process.env.VITE_POSTHOG_KEY?.trim();
if (expectedAnalyticsKey) {
	const hasAnalyticsKey = readdirSync(resolve(dist, "assets"))
		.filter((asset) => asset.endsWith(".js"))
		.some((asset) =>
			readFileSync(resolve(dist, "assets", asset), "utf8").includes(
				expectedAnalyticsKey,
			),
		);
	if (!hasAnalyticsKey) {
		throw new Error(
			"Renderer bundle is missing the configured analytics ingest key",
		);
	}
}
const manifest = JSON.parse(
	readFileSync(resolve(dist, ".vite/manifest.json"), "utf8"),
);
const assets = collectEntryAssets(manifest, "index.html");
const startupAssets = collectRouteAssets(
	manifest,
	"index.html",
	"src/startup-application.tsx",
);
const hasStartupSettings = startupAssets.some((asset) =>
	asset.includes("settings-client-bus-"),
);
if (!hasStartupSettings) {
	throw new Error(
		"Renderer startup chunk must include settings readiness before loading the full application; otherwise packaged builds can remain stuck before opening RPC.",
	);
}
const defaultRouteAssets = collectRouteAssets(
	manifest,
	"index.html",
	"src/application.tsx",
);

const measure = (measuredAssets) => {
	const totals = { js: 0, css: 0 };
	for (const asset of measuredAssets) {
		const kind = asset.endsWith(".css") ? "css" : "js";
		totals[kind] += gzipSync(readFileSync(resolve(dist, asset))).byteLength;
	}
	return totals;
};

const totals = measure(assets);
const defaultRouteTotals = measure(defaultRouteAssets);
const budgets = { js: 200 * 1024, css: 100 * 1024 };
for (const kind of ["js", "css"]) {
	const kib = (totals[kind] / 1024).toFixed(1);
	const limit = budgets[kind] / 1024;
	console.log(`initial ${kind}: ${kib} KiB gzip (budget ${limit} KiB)`);
	if (totals[kind] > budgets[kind]) process.exitCode = 1;
}

const defaultRouteBudget = 500 * 1024;
console.log(
	`default route js: ${(defaultRouteTotals.js / 1024).toFixed(1)} KiB gzip (budget ${defaultRouteBudget / 1024} KiB)`,
);
if (defaultRouteTotals.js > defaultRouteBudget) process.exitCode = 1;

const lazyChunkBudget = 250 * 1024;
const lazyChunks = readdirSync(resolve(dist, "assets"))
	.filter(
		(asset) => asset.endsWith(".js") && !assets.includes(`assets/${asset}`),
	)
	.map((asset) => ({
		asset,
		gzipBytes: gzipSync(readFileSync(resolve(dist, "assets", asset)))
			.byteLength,
	}))
	.sort((left, right) => right.gzipBytes - left.gzipBytes);
const largestLazy = lazyChunks[0];
if (largestLazy !== undefined) {
	console.log(
		`largest lazy chunk: ${largestLazy.asset} ${(largestLazy.gzipBytes / 1024).toFixed(1)} KiB gzip (budget ${lazyChunkBudget / 1024} KiB)`,
	);
}
for (const chunk of lazyChunks) {
	if (chunk.gzipBytes <= lazyChunkBudget) continue;
	console.error(
		`Lazy chunk budget exceeded: ${chunk.asset} is ${(chunk.gzipBytes / 1024).toFixed(1)} KiB gzip.`,
	);
	process.exitCode = 1;
}

if (process.exitCode) {
	console.error(
		`Renderer bundle budget exceeded for ${basename(dirname(dist))}.`,
	);
}
