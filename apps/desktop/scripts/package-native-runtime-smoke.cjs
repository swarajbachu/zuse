const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const Path = require("node:path");
const { tmpdir } = require("node:os");
const { DatabaseSync } = require("node:sqlite");

const appAsar = process.argv[2];
if (!appAsar) {
	throw new Error("Usage: package-native-runtime-smoke.cjs <app.asar>");
}

const requireFromPackage = createRequire(
	Path.join(Path.resolve(appAsar), "package.json"),
);

const Parser = requireFromPackage("tree-sitter");
const grammars = [
	[
		"javascript",
		requireFromPackage("tree-sitter-javascript"),
		"const answer = 42;",
		"program",
	],
	["json", requireFromPackage("tree-sitter-json"), '{"answer":42}', "document"],
	[
		"typescript",
		requireFromPackage("tree-sitter-typescript").typescript,
		"const answer: number = 42;",
		"program",
	],
	[
		"tsx",
		requireFromPackage("tree-sitter-typescript").tsx,
		"const answer = <strong>42</strong>;",
		"program",
	],
];

for (const [name, grammar, source, expectedRootType] of grammars) {
	const parser = new Parser();
	parser.setLanguage(grammar);
	const tree = parser.parse(source);
	assert.equal(
		tree.rootNode.hasError,
		false,
		`${name} grammar failed to parse`,
	);
	assert.equal(tree.rootNode.type, expectedRootType);
	assert.ok(
		Array.isArray(grammar.nodeTypeInfo) && grammar.nodeTypeInfo.length > 0,
		`${name} node-type metadata is missing`,
	);
}

const providerSdk = requireFromPackage("@cursor/sdk");
const providerSqlite = requireFromPackage("@cursor/sdk/sqlite");
assert.equal(typeof providerSdk.Agent.create, "function");
assert.equal(typeof providerSdk.Cursor.models.list, "function");
assert.equal(typeof providerSqlite.SqliteLocalAgentStore, "function");

const database = new DatabaseSync(":memory:");
try {
	database.exec("CREATE TABLE smoke (value TEXT)");
	database.prepare("INSERT INTO smoke VALUES (?)").run("ok");
	assert.equal(database.prepare("SELECT value FROM smoke").get().value, "ok");
} finally {
	database.close();
}
const keytar = requireFromPackage("keytar");
assert.equal(typeof keytar.getPassword, "function");
const credentialCheck = (async () => {
	if (process.platform !== "win32") return;
	const service = `zuse-package-smoke-${process.pid}-${Date.now()}`;
	try {
		await keytar.setPassword(service, "fixture", "fixture-only");
		assert.equal(await keytar.getPassword(service, "fixture"), "fixture-only");
	} finally {
		await keytar.deletePassword(service, "fixture");
	}
	console.log("Packaged Windows credentials round-trip passed.");
})();
const pty = requireFromPackage("node-pty");
const terminal = pty.spawn(
	process.platform === "win32" ? "powershell.exe" : "/bin/sh",
	process.platform === "win32"
		? [
				"-NoProfile",
				"-NonInteractive",
				"-Command",
				"Write-Output zuse-pty-smoke",
			]
		: ["-c", "printf zuse-pty-smoke"],
	{
		name: "xterm-256color",
		cols: 80,
		rows: 24,
		cwd: tmpdir(),
		env: { ...process.env, TERM: "xterm-256color" },
	},
);
let output = "";
terminal.onData((data) => {
	output += data;
});

const timeout = setTimeout(() => {
	throw new Error(
		`Packaged native runtime did not finish and release its resources: ${process.getActiveResourcesInfo().join(", ")}; PTY output: ${output}`,
	);
}, 20_000);

const terminalCheck = new Promise((resolve, reject) => {
	terminal.onExit(({ exitCode }) => {
		try {
			// A naturally exited Windows shell still owns node-pty's output worker.
			if (process.platform === "win32") terminal.kill();
			assert.equal(exitCode, 0);
			assert.match(output, /zuse-pty-smoke/u);
			resolve();
		} catch (error) {
			reject(error);
		}
	});
});
Promise.all([credentialCheck, terminalCheck])
	.then(() => {
		// Do not force exit: lingering native workers must fail this smoke check.
		timeout.unref();
		console.log("Desktop packaged native runtime smoke passed.");
	})
	.catch((error) => {
		console.error(error);
		process.exitCode = 1;
		timeout.unref();
	});
