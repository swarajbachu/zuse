const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const Path = require("node:path");

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

const pty = requireFromPackage("node-pty");
const terminal = pty.spawn("/bin/sh", ["-c", "printf zuse-pty-smoke"], {
	name: "xterm-256color",
	cols: 80,
	rows: 24,
	cwd: "/tmp",
	env: { ...process.env, TERM: "xterm-256color" },
});
let output = "";
terminal.onData((data) => {
	output += data;
});

const timeout = setTimeout(() => {
	terminal.kill();
	throw new Error(`Packaged node-pty smoke timed out; output: ${output}`);
}, 5_000);

terminal.onExit(({ exitCode }) => {
	clearTimeout(timeout);
	assert.equal(exitCode, 0);
	assert.match(output, /zuse-pty-smoke/u);
	console.log("Desktop packaged native runtime smoke passed.");
});
