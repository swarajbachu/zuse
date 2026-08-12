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
});
