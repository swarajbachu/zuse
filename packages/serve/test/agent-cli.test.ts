import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import { describe, expect, test } from "vitest";
import { __testing, isAgentCliCommand } from "../src/agent-cli.ts";

describe("agent CLI", () => {
	test("recognizes control-plane commands without stealing serve commands", () => {
		expect(isAgentCliCommand(["chat", "list"])).toBe(true);
		expect(isAgentCliCommand(["session", "send"])).toBe(true);
		expect(isAgentCliCommand(["serve", "status"])).toBe(false);
	});

	test("parses repeatable and inline options", () => {
		const parsed = __testing.parse([
			"session",
			"send",
			"--session=s_1",
			"--file",
			"a.ts",
			"--file",
			"b.ts",
			"--include-archived",
		]);
		expect(parsed.positionals).toEqual(["session", "send"]);
		expect(parsed.flags.get("session")).toEqual(["s_1"]);
		expect(parsed.flags.get("file")).toEqual(["a.ts", "b.ts"]);
		expect(parsed.flags.get("include-archived")).toEqual(["true"]);
	});

	test("publishes a machine-readable command manifest", () => {
		const manifest = __testing.commandManifest();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.commands).toContain("chat create");
		expect(manifest.commands).toContain("session mode");
		expect(manifest.commands).toContain("session send");
		expect(manifest.commands).toContain("session fork");
		expect(manifest.commands).toContain("session model");
		expect(manifest.commands).toContain("session provider");
		expect(manifest.commands).toContain("session transcript");
		expect(manifest.commands).toContain("session plan");
		expect(manifest.commands).toContain("session plan-respond");
		expect(manifest.commands).toContain("session answer");
		expect(manifest.commands).toContain("session queue-add");
		expect(manifest.commands).toContain("chat archive");
		expect(manifest.commands).toContain("chat workspace");
		expect(manifest.contextOptions).toEqual([
			"--attach",
			"--file",
			"--linear",
			"--transcript",
			"--plan",
		]);
		expect(manifest.deleteRequires).toBe("--confirm");
	});

	test("expands JSON input into the same repeatable flag contract", async () => {
		const argv = await __testing.expandInputJson([
			"session",
			"send",
			"--input-json",
			JSON.stringify({
				session: "s_1",
				file: ["a.ts", "b.ts"],
				permission: "plan",
			}),
		]);
		const parsed = __testing.parse(argv);
		expect(parsed.flags.get("session")).toEqual(["s_1"]);
		expect(parsed.flags.get("file")).toEqual(["a.ts", "b.ts"]);
		expect(parsed.flags.get("permission")).toEqual(["plan"]);
	});

	test("discovers the protected local dev RPC descriptor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-access-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:8788/rpc",
				token: "zt_development",
			}),
		);
		await expect(
			__testing.localCliAccess({ ZUSE_DEV_CLI_ACCESS_FILE: accessFile }),
		).resolves.toEqual({
			schemaVersion: 1,
			wsUrl: "ws://127.0.0.1:8788/rpc",
			token: "zt_development",
		});
	});

	test("discovers the protected installed desktop RPC descriptor", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-user-data-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:47837/rpc",
				token: "zt_installed",
			}),
		);
		await expect(
			__testing.localCliAccess({ ZUSE_USER_DATA_DIR: directory }),
		).resolves.toEqual({
			schemaVersion: 1,
			wsUrl: "ws://127.0.0.1:47837/rpc",
			token: "zt_installed",
		});
		const endpoint = new URL(
			await __testing.endpoint(__testing.parse(["chat", "list"]), {
				ZUSE_USER_DATA_DIR: directory,
			}),
		);
		expect(endpoint.origin).toBe("ws://127.0.0.1:47837");
		expect(endpoint.pathname).toBe("/rpc");
		expect(endpoint.searchParams.get("token")).toBe("zt_installed");
	});

	test("negotiates the current wire protocol with local dev RPC", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-cli-endpoint-"));
		const accessFile = join(directory, "cli-access.json");
		await writeFile(
			accessFile,
			JSON.stringify({
				schemaVersion: 1,
				wsUrl: "ws://127.0.0.1:8788/rpc",
				token: "zt_development",
			}),
		);
		const endpoint = new URL(
			await __testing.endpoint(__testing.parse(["computer", "list"]), {
				ZUSE_DEV_CLI_ACCESS_FILE: accessFile,
			}),
		);
		expect(endpoint.searchParams.get("wireVersion")).toBe(
			String(WIRE_PROTOCOL_VERSION),
		);
		expect(endpoint.searchParams.get("token")).toBe("zt_development");
	});
});
