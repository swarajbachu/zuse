import { spawnSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

const repoRoot = resolve(import.meta.dirname, "..");
const requestedSamples = Number(
	process.argv.find((value) => value.startsWith("--samples="))?.split("=")[1] ??
		"5",
);
if (!Number.isInteger(requestedSamples) || requestedSamples < 5) {
	throw new Error("--samples must be an integer of at least 5.");
}

const selected = new Set(
	(
		process.argv.find((value) => value.startsWith("--only="))?.split("=")[1] ??
		"renderer-build,desktop-pack,server-pack,tests,biome,types"
	)
		.split(",")
		.filter(Boolean),
);

const median = (samples) => {
	const sorted = [...samples].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
		: sorted[middle];
};

const runSample = ({ command, args, cwd, env }) => {
	const startedAt = process.hrtime.bigint();
	const result = spawnSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: "ignore",
	});
	const durationMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
	if (result.status !== 0) {
		throw new Error(
			`${command} ${args.join(" ")} failed (${result.status ?? result.signal ?? "unknown"}).`,
		);
	}
	return durationMs;
};

const measure = (name, spec) => {
	if (!selected.has(name)) return null;
	const samplesMs = [];
	const cleanupAll = spec.beforeAll?.();
	try {
		for (let index = 0; index < requestedSamples; index += 1) {
			const cleanup = spec.beforeEach?.(index);
			try {
				samplesMs.push(runSample(spec.command(index)));
			} finally {
				cleanup?.();
			}
		}
	} finally {
		cleanupAll?.();
	}
	return { samplesMs, medianMs: median(samplesMs) };
};

const rendererDir = resolve(repoRoot, "apps/renderer");
const rendererBuildCold = measure("renderer-build", {
	beforeEach: () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "zuse-vite-cache-"));
		process.env.ZUSE_VITE_CACHE_DIR = cacheDir;
		return () => {
			delete process.env.ZUSE_VITE_CACHE_DIR;
			rmSync(cacheDir, { recursive: true, force: true });
		};
	},
	command: () => ({
		command: "bun",
		args: ["run", "build"],
		cwd: rendererDir,
	}),
});
const rendererBuildWarm = measure("renderer-build", {
	beforeAll: () => {
		const cacheDir = mkdtempSync(join(tmpdir(), "zuse-vite-cache-warm-"));
		process.env.ZUSE_VITE_CACHE_DIR = cacheDir;
		runSample({ command: "bun", args: ["run", "build"], cwd: rendererDir });
		return () => {
			delete process.env.ZUSE_VITE_CACHE_DIR;
			rmSync(cacheDir, { recursive: true, force: true });
		};
	},
	command: () => ({ command: "bun", args: ["run", "build"], cwd: rendererDir }),
});

const isolatedPack = (prefix, envName, cwd) => ({
	beforeEach: () => {
		const outDir = mkdtempSync(join(tmpdir(), prefix));
		process.env[envName] = outDir;
		return () => {
			delete process.env[envName];
			rmSync(outDir, { recursive: true, force: true });
		};
	},
	command: () => ({ command: "bunx", args: ["vp", "pack"], cwd }),
});

const desktopPack = measure(
	"desktop-pack",
	isolatedPack(
		"zuse-desktop-pack-",
		"ZUSE_DESKTOP_OUT_DIR",
		resolve(repoRoot, "apps/desktop"),
	),
);
const serverPack = measure(
	"server-pack",
	isolatedPack(
		"zuse-server-pack-",
		"ZUSE_SERVER_OUT_DIR",
		resolve(repoRoot, "apps/server"),
	),
);
const tests = measure("tests", {
	command: () => ({
		command: "bun",
		args: ["run", "--filter", "renderer", "test:unit"],
		cwd: repoRoot,
	}),
});
const biome = measure("biome", {
	command: () => ({
		command: "bunx",
		args: ["biome", "check", "."],
		cwd: repoRoot,
	}),
});
const types = measure("types", {
	command: () => ({
		command: "bun",
		args: ["run", "check-types"],
		cwd: repoRoot,
	}),
});

const initialTransfer = () => {
	const dist = resolve(rendererDir, "dist");
	const html = readFileSync(resolve(dist, "index.html"), "utf8");
	const assets = [...html.matchAll(/(?:src|href)="\.\/([^"?]+\.(?:js|css))"/g)]
		.map((match) => match[1])
		.filter((asset, index, all) => all.indexOf(asset) === index);
	const totals = { js: 0, css: 0 };
	for (const asset of assets) {
		const kind = asset.endsWith(".css") ? "css" : "js";
		totals[kind] += gzipSync(readFileSync(resolve(dist, asset))).byteLength;
	}
	return { javascriptGzipBytes: totals.js, cssGzipBytes: totals.css };
};

const workerAndLazyChunks = () => {
	const assetsDir = resolve(rendererDir, "dist/assets");
	return readdirSync(assetsDir)
		.filter((name) => /(?:worker|mermaid|shiki|browser-pane)/u.test(name))
		.map((name) => ({
			name: basename(name),
			bytes: statSync(join(assetsDir, name)).size,
		}))
		.sort((left, right) => right.bytes - left.bytes);
};

console.log(
	JSON.stringify(
		{
			generatedAt: new Date().toISOString(),
			samplesPerMetric: requestedSamples,
			complete: false,
			metrics: {
				rendererBuildCold,
				rendererBuildWarm,
				desktopPack,
				serverPack,
				tests,
				biome,
				types,
				initialTransfer: initialTransfer(),
				workerAndLazyChunks: workerAndLazyChunks(),
			},
			externalHarnessMetrics: {
				rendererColdStartup: { status: "not-measured" },
				rendererWarmStartup: { status: "not-measured" },
				electronFirstPageReady: { status: "not-measured" },
				chromiumFirstPageReady: { status: "not-measured" },
				hmrLatency: { status: "not-measured" },
			},
		},
		null,
		2,
	),
);
