import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { compileExtension } from "../packages/extension-host/src/compiler.ts";
import { initializeExtension } from "../packages/serve/src/extension-init.ts";

const archive = process.argv[2];
if (!archive) throw new Error("Pass the packed extension SDK tarball path.");
const root = await mkdtemp(join(tmpdir(), "zuse-extension-starters-"));
try {
	for (const template of ["acp", "workspace"]) {
		const directory = join(root, template);
		await initializeExtension({
			directory,
			id: "team-agent",
			name: "Team agent",
			publisher: "Tests",
			template,
			command: ["opencode", "acp"],
			sdk: resolve(archive),
		});
		const manifest = JSON.parse(
			await readFile(join(directory, "zuse-extension.json"), "utf8"),
		);
		await compileExtension({
			server: join(directory, manifest.server),
			...(manifest.client ? { client: join(directory, manifest.client) } : {}),
		});
		console.log(
			`${template}: standalone install, type check and compilation passed`,
		);
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
