import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, test } from "vitest";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});
const fixture = () => {
	const root = mkdtempSync(join(tmpdir(), "zuse-fork-prepare-"));
	roots.push(root);
	// Embed the same shared resolver as the production API fork command.
	const helper = readFileSync(
		new URL("../../../cloud-sandboxes/workspace-runtime.sh", import.meta.url),
		"utf8",
	);
	// Relocate every absolute sandbox path before executing the real script.
	const script = (
		helper +
		"\n" +
		readFileSync(
			new URL(
				"../../../cloud-sandboxes/workspace-fork-prepare.sh",
				import.meta.url,
			),
			"utf8",
		)
	)
		.replaceAll("/var/lib/zuse", join(root, "data"))
		.replaceAll("/run/zuse-secrets", join(root, "secrets"))
		.replaceAll("/home/zuse", join(root, "home"))
		.replaceAll("/srv/zuse/home", join(root, "srv"));
	const data = join(root, "data/user-data");
	mkdirSync(join(data, "attachments"), { recursive: true });
	writeFileSync(join(data, "attachments/file"), "attachment");
	const db = new DatabaseSync(join(data, "zuse.sqlite"));
	db.exec(
		"PRAGMA journal_mode=WAL; CREATE TABLE sessions (id TEXT, chat_id TEXT); CREATE TABLE messages (id TEXT, session_id TEXT); INSERT INTO sessions VALUES ('session','chat'); INSERT INTO messages VALUES ('message','session');",
	);
	// Keep the connection open so WAL is required to read the captured rows.
	const run = (message = "message", native = false) =>
		execFileSync("bash", ["-c", script], {
			env: {
				...process.env,
				ZUSE_CLOUD_WORKSPACE_ID: "child",
				ZUSE_USER_DATA: data,
				ZUSE_RUNTIME_NODE: process.execPath,
				ZUSE_FORK_CHAT_ID: "chat",
				ZUSE_FORK_SESSION_ID: "session",
				ZUSE_FORK_MESSAGE_ID: message,
				ZUSE_SNAPSHOT_NATIVE: native ? "1" : "",
			},
			stdio: "pipe",
		});
	return { root, data, db, run };
};
test("retains the full source including WAL and attachments, and retries without replacing the new live store", () => {
	const { root, data, db, run } = fixture();
	try {
		run();
		const retained = join(root, "data/fork-source/child/user-data");
		expect(existsSync(join(retained, "zuse.sqlite-wal"))).toBe(true);
		const copy = new DatabaseSync(join(retained, "zuse.sqlite"), {
			readOnly: true,
		});
		try {
			expect(copy.prepare("SELECT id FROM messages").get()?.id).toBe("message");
		} finally {
			copy.close();
		}
		expect(existsSync(join(data, "zuse.sqlite"))).toBe(false);
		expect(readFileSync(join(data, "attachments/file"), "utf8")).toBe(
			"attachment",
		);
		writeFileSync(join(data, "new-runtime-state"), "keep");
		run();
		expect(readFileSync(join(data, "new-runtime-state"), "utf8")).toBe("keep");
	} finally {
		db.close();
	}
});
test("rejects an unknown fork point before moving data or initializing storage", () => {
	const { root, data, db, run } = fixture();
	try {
		expect(() => run("missing")).toThrow();
		expect(existsSync(join(data, "zuse.sqlite"))).toBe(true);
		expect(existsSync(join(root, "data/fork-source/child/prepared"))).toBe(
			false,
		);
		expect(existsSync(join(root, "data/fork-source/child/failed"))).toBe(true);
	} finally {
		db.close();
	}
});

test("native machine forks replace only Zuse-owned SSH identity and preserve native credentials", () => {
	const { root, data, db, run } = fixture();
	try {
		mkdirSync(join(root, "home/.ssh"), { recursive: true });
		mkdirSync(join(root, "home/.config/gh"), { recursive: true });
		mkdirSync(join(root, "data/ssh"), { recursive: true });
		mkdirSync(join(root, "data/workspace"), { recursive: true });
		writeFileSync(join(root, "home/.ssh/authorized_keys"), "native-key");
		writeFileSync(join(root, "home/.config/gh/hosts.yml"), "native-login");
		writeFileSync(join(root, "data/ssh/authorized_keys"), "copied-zuse-key");
		run("message", true);
		expect(readFileSync(join(root, "home/.ssh/authorized_keys"), "utf8")).toBe(
			"native-key",
		);
		expect(readFileSync(join(root, "home/.config/gh/hosts.yml"), "utf8")).toBe(
			"native-login",
		);
		expect(existsSync(join(root, "data/ssh/authorized_keys"))).toBe(false);
		expect(readFileSync(join(root, "data/workspace/owner"), "utf8")).toBe(
			"child\n",
		);
		writeFileSync(join(data, "child-state"), "keep");
		run("message", true);
		expect(readFileSync(join(data, "child-state"), "utf8")).toBe("keep");
	} finally {
		db.close();
	}
});
