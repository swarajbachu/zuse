// Credential-free Linux UID boundary and actual bundled reader protocol probe.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	chmodSync,
	chownSync,
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

if (process.getuid() !== 0)
	throw new Error("Run this credential-free probe with sudo node");
const sourceBundle = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../dist-review/review-worker.mjs",
);
const root = mkdtempSync(join(tmpdir(), "zuse-review-isolation-"));
chmodSync(root, 0o711);
const image = join(root, "image");
mkdirSync(image, { mode: 0o755 });
const bundle = join(image, "review-worker.mjs");
cpSync(sourceBundle, bundle);
cpSync(
	join(dirname(sourceBundle), "node_modules"),
	join(image, "node_modules"),
	{ recursive: true },
);
const auth = join(root, "auth");
mkdirSync(auth, { mode: 0o700 });
chownSync(auth, 1000, 1000);
writeFileSync(
	join(auth, ".credentials.json"),
	"CANARY_NOT_A_PROVIDER_CREDENTIAL",
	{ mode: 0o600 },
);
chownSync(join(auth, ".credentials.json"), 1000, 1000);
const repo = join(root, "repo");
mkdirSync(repo, { mode: 0o700 });
const git = (...args) =>
	execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"user.name=Review Probe",
			"-c",
			"user.email=review-probe@example.invalid",
			"-C",
			repo,
			...args,
		],
		{
			encoding: "utf8",
			env: {
				PATH: "/usr/bin:/bin",
				HOME: root,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	).trim();
const assign = (path) => {
	chownSync(path, 1001, 1001);
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) assign(child);
		else chownSync(child, 1001, 1001);
	}
};
let child;
try {
	git("init");
	writeFileSync(join(repo, "a.ts"), "export function before() { return 1; }\n");
	git("add", ".");
	git("commit", "-m", "base");
	const baseSha = git("rev-parse", "HEAD");
	writeFileSync(
		join(repo, "a.ts"),
		'import { helper } from "./b";\nexport function after() { return helper(); }\n',
	);
	writeFileSync(join(repo, "b.ts"), "export function helper() { return 2; }\n");
	git("add", ".");
	git("commit", "-m", "head");
	const headSha = git("rev-parse", "HEAD");
	assign(repo);
	for (const [uid, forbidden] of [
		[1001, join(auth, ".credentials.json")],
		[1001, `/proc/${process.pid}/environ`],
		[1000, join(repo, "a.ts")],
	]) {
		const script = `const fs=require('node:fs'); try { fs.readFileSync(${JSON.stringify(forbidden)}); process.exit(9); } catch(e) { if(e.code!=='EACCES') process.exit(8); }`;
		execFileSync(process.execPath, ["-e", script], {
			uid,
			gid: uid,
			env: { PATH: "/usr/bin:/bin" },
		});
	}
	const snapshot = {
		repositoryId: 1,
		baseRef: "main",
		baseSha,
		headSha,
		mergeBaseSha: baseSha,
	};
	child = spawn(
		process.execPath,
		[bundle, "reader", "--root", repo, "--snapshot", JSON.stringify(snapshot)],
		{
			uid: 1001,
			gid: 1001,
			env: { PATH: "/usr/bin:/bin", HOME: repo },
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	let stderr = "";
	child.stderr.on("data", (data) => {
		stderr += data;
	});
	const iterator = createInterface({ input: child.stdout })[
		Symbol.asyncIterator
	]();
	const next = async () => {
		const value = await iterator.next();
		if (value.done) throw new Error(`Reader stopped: ${stderr}`);
		return JSON.parse(value.value);
	};
	const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
	try {
		const ready = (await next()).ready;
		assert.equal(ready.snapshot.headSha, headSha);
		assert.ok(
			ready.relations["RIGHT:a.ts"].some((entry) => entry.path === "b.ts"),
		);
		child.stdin.write(
			`${JSON.stringify({ id: 1, op: "read", side: "RIGHT", path: "a.ts" })}\n`,
		);
		assert.match((await next()).text, /helper/);
		child.stdin.write(
			`${JSON.stringify({ id: 2, op: "search", side: "RIGHT", path: "helper", limit: 10 })}\n`,
		);
		assert.ok((await next()).text.length > 0);
		child.stdin.write(
			`${JSON.stringify({ id: 3, op: "read", side: "RIGHT", path: join(auth, ".credentials.json") })}\n`,
		);
		const exit = await new Promise((resolve) => child.once("exit", resolve));
		assert.equal(exit, 1);
		assert.equal(
			readFileSync(join(auth, ".credentials.json"), "utf8"),
			"CANARY_NOT_A_PROVIDER_CREDENTIAL",
		);
		console.log(
			JSON.stringify({
				uidIsolation: "passed",
				immutableReader: "passed",
				indexSearch: "passed",
				staticRelationships: "passed",
				authCanary: "unreadable",
				providerInference: "not-run",
			}),
		);
	} finally {
		clearTimeout(timer);
	}
} finally {
	child?.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
}
