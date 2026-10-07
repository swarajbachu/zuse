import assert from "node:assert/strict";
import { chown, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
	executeCheck,
	packageInfo,
	runChecks,
	validateBunLock,
} from "../src/review/check-runner.mjs";

if (process.getuid() !== 0)
	throw new Error("Run with sudo node; no credentials or network required");
const root = "/run/zuse-review-checks";
try {
	await stat(root);
	throw new Error("Refusing to replace existing checks data");
} catch (error) {
	if (error.code !== "ENOENT") throw error;
}
await mkdir(root, { mode: 0o711 });
try {
	await writeFile(`${root}/secret-canary`, "NEVER_PRINT_THIS_CANARY", {
		mode: 0o600,
	});
	const script = `const fs=require('node:fs'); for(const path of ['${root}/secret-canary','${root}/plan.json','/proc/'+process.ppid+'/environ']){try{fs.readFileSync(path);process.exit(9)}catch(e){if(e.code!=='EACCES')process.exit(8)}};if(process.env.ZUSE_REVIEW_GIT_TOKEN||process.env.ZUSE_REVIEW_BOOT_TOKEN)process.exit(7);try{fs.writeFileSync('${root}/status.json','fake');process.exit(6)}catch(e){if(e.code!=='EACCES')process.exit(5)};console.log('boundaries verified');process.exit(require('./value.cjs')?0:1);`;
	for (const side of ["base", "head"]) {
		await mkdir(`${root}/${side}`, { mode: 0o700 });
		await chown(`${root}/${side}`, 1001, 1001);
		await writeFile(`${root}/${side}/check.cjs`, script);
		await writeFile(
			`${root}/${side}/value.cjs`,
			`module.exports=${side === "base"};`,
		);
	}
	const input = {
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
		deadlineMs: Date.now() + 30_000,
	};
	await writeFile(
		`${root}/plan.json`,
		JSON.stringify({
			...input,
			checks: [{ script: "test", command: "node check.cjs" }],
		}),
		{ mode: 0o600 },
	);
	await runChecks(input);
	const result = JSON.parse(await readFile(`${root}/status.json`, "utf8"));
	assert.equal(result.phase, "complete");
	assert.equal(result.checks[0].base.status, "passed");
	assert.equal(result.checks[0].head.status, "failed");
	assert.equal(result.checks[0].head.exitCode, 1);
	assert.match(result.checks[0].base.output, /boundaries verified/);
	assert.equal(
		JSON.stringify(result).includes("NEVER_PRINT_THIS_CANARY"),
		false,
	);
	const timeout = await executeCheck(
		"/usr/local/bin/node",
		["-e", "setInterval(()=>{},1000)"],
		`${root}/head`,
		Date.now() + 100,
	);
	assert.equal(timeout.status, "timeout");
	await rm(`${root}/run-lock`, { recursive: true });
	await writeFile(
		`${root}/plan.json`,
		JSON.stringify({ ...input, checks: [] }),
		{ mode: 0o600 },
	);
	await runChecks(input);
	assert.equal(
		JSON.parse(await readFile(`${root}/status.json`, "utf8")).reason,
		"not_available",
	);
	const workspace = `${root}/workspace-fixture`;
	await mkdir(`${workspace}/packages/lib`, { recursive: true });
	await writeFile(
		`${workspace}/package.json`,
		JSON.stringify({
			name: "fixture",
			workspaces: {
				packages: ["packages/*"],
				catalog: { typescript: "5.9.2" },
			},
			dependencies: { "@fixture/lib": "workspace:*", typescript: "catalog:" },
		}),
	);
	await writeFile(
		`${workspace}/packages/lib/package.json`,
		JSON.stringify({ name: "@fixture/lib", version: "1.0.0" }),
	);
	const metadata = await packageInfo(workspace);
	assert.equal(metadata.reviewWorkspacePaths.has("packages/lib"), true);
	validateBunLock(
		JSON.stringify({
			packages: {
				"@fixture/lib": ["@fixture/lib@workspace:packages/lib"],
				typescript: ["typescript@5.9.2", "", {}, "sha512-YQ=="],
			},
		}),
		metadata.reviewWorkspacePaths,
	);
	assert.throws(() =>
		validateBunLock(
			JSON.stringify({ packages: { lib: ["lib@workspace:../../secret"] } }),
			metadata.reviewWorkspacePaths,
		),
	);
	await writeFile(
		`${workspace}/packages/lib/.npmrc`,
		"registry=https://evil.example",
	);
	await assert.rejects(packageInfo(workspace));
	console.log(
		JSON.stringify({
			basePassedHeadFailed: "passed",
			rootStatusProtection: "passed",
			credentialCanary: "unreadable",
			parentEnvironment: "unreadable",
			timeout: "passed",
			missingScripts: "not_available",
			network: "not-used",
		}),
	);
} finally {
	await rm(root, { recursive: true, force: true });
}
