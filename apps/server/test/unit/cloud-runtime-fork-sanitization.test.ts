import { execFileSync } from "node:child_process";
import {
	access,
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";

it.each([
	"canonical",
	"legacy",
	"srv",
	"alias",
	"ambiguous",
])("preserves populated %s fork storage and sanitizes identity without guessing between distinct databases", async (layout) => {
	const directory = await mkdtemp(join(tmpdir(), "zuse-fork-sanitize-"));
	const root = join(directory, "var");
	const target = join(root, "user-data");
	const legacy = join(directory, "home", ".zuse-data");
	const data =
		layout === "legacy" || layout === "alias"
			? legacy
			: layout === "srv"
				? join(directory, "srv", ".zuse-data")
				: target;
	const childData = layout === "alias" ? legacy : target;
	try {
		await mkdir(join(data, "attachments"), { recursive: true });
		await mkdir(join(root, "workspace"), { recursive: true });
		await writeFile(
			join(data, "attachments", "kept.txt"),
			"retained attachment",
		);
		await writeFile(
			join(data, "cloud-runtime-identity.json"),
			"parent private keys and bearer",
		);
		await writeFile(
			join(data, "cloud-runtime-identity.json.interrupted.next"),
			"parent pending rotation",
		);
		const database = new DatabaseSync(join(data, "zuse.sqlite"));
		database.exec(
			"CREATE TABLE sessions (id TEXT, chat_id TEXT); CREATE TABLE messages (id TEXT, session_id TEXT, content TEXT); INSERT INTO sessions VALUES ('session-1','chat-1'); INSERT INTO messages VALUES ('message-1','session-1','retained message');",
		);
		database.close();
		if (layout === "alias") await symlink(legacy, target);
		if (layout === "ambiguous") {
			await mkdir(legacy, { recursive: true });
			await copyFile(join(data, "zuse.sqlite"), join(legacy, "zuse.sqlite"));
		}
		const original = await readFile(
			new URL(
				"../../../../infra/cloud-sandboxes/workspace-fork-prepare.sh",
				import.meta.url,
			),
			"utf8",
		);
		const helper = await readFile(
			new URL(
				"../../../../infra/cloud-sandboxes/workspace-runtime.sh",
				import.meta.url,
			),
			"utf8",
		);
		// Redirect every absolute mutation into the fixture; execute the shared resolver and real script.
		const script = `${helper}
${original}`
			.replaceAll("/var/lib/zuse", root)
			.replaceAll("/run/zuse-secrets", join(directory, "secrets"))
			.replaceAll("/home/zuse", join(directory, "home"))
			.replaceAll("/srv/zuse/home", join(directory, "srv"));
		const file = join(directory, "prepare.sh");
		await writeFile(file, script);
		const run = () =>
			execFileSync("bash", [file], {
				env: {
					...process.env,
					ZUSE_CLOUD_WORKSPACE_ID: "child-1",
					ZUSE_USER_DATA: target,
					ZUSE_FORK_CHAT_ID: "chat-1",
					ZUSE_FORK_SESSION_ID: "session-1",
					ZUSE_FORK_MESSAGE_ID: "message-1",
					ZUSE_RUNTIME_NODE: process.execPath,
					ZUSE_SNAPSHOT_NATIVE: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
		if (layout === "ambiguous") {
			expect(run).toThrow();
			for (const location of [data, legacy]) {
				const retained = new DatabaseSync(join(location, "zuse.sqlite"), {
					readOnly: true,
				});
				expect(
					retained.prepare("SELECT content FROM messages").get(),
				).toMatchObject({ content: "retained message" });
				retained.close();
			}
			expect(
				await readFile(join(data, "cloud-runtime-identity.json"), "utf8"),
			).toBe("parent private keys and bearer");
			await expect(
				access(
					join(root, "fork-source", "child-1", "user-data", "zuse.sqlite"),
				),
			).rejects.toThrow();
			return;
		}
		run();
		run(); // Interrupted/repeated preparation does not move or reset the preserved DB.
		const source = join(root, "fork-source", "child-1", "user-data");
		for (const location of [source, childData]) {
			await expect(
				access(join(location, "cloud-runtime-identity.json")),
			).rejects.toThrow();
			await expect(
				access(join(location, "cloud-runtime-identity.json.interrupted.next")),
			).rejects.toThrow();
		}
		const retained = new DatabaseSync(join(source, "zuse.sqlite"), {
			readOnly: true,
		});
		expect(
			retained.prepare("SELECT content FROM messages").get(),
		).toMatchObject({ content: "retained message" });
		expect(retained.prepare("PRAGMA integrity_check").get()).toMatchObject({
			integrity_check: "ok",
		});
		retained.close();
		await expect(access(join(childData, "zuse.sqlite"))).rejects.toThrow();
		expect(
			await readFile(join(childData, "attachments", "kept.txt"), "utf8"),
		).toBe("retained attachment");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
