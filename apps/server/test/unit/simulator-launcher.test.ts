import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ChatId } from "@zuse/contracts";
import { expect, it } from "vitest";
import { simulatorLauncher } from "../../src/simulators/launcher.ts";

const exec = promisify(execFile);
it("pins the target and endpoint, removes ambient overrides and rejects revoked or obsolete launchers", async () => {
	const root = await mkdtemp(join(tmpdir(), "zuse-launcher-"));
	const target = { chatId: ChatId.make("chat-a"), deviceId: "ABC-123" },
		session = "session",
		owner = "owner";
	const access = join(root, "access.json"),
		entry = join(root, "fake-agent.mjs");
	try {
		await mkdir(join(root, "agent-device", session), { recursive: true });
		await writeFile(
			entry,
			`console.log(JSON.stringify({args:process.argv.slice(2),endpoint:process.env.AGENT_DEVICE_DAEMON_BASE_URL,platform:process.env.AGENT_DEVICE_PLATFORM,config:process.env.AGENT_DEVICE_CONFIG}));`,
		);
		await writeFile(
			access,
			JSON.stringify({ enabled: true, owner, pid: process.pid }),
		);
		await writeFile(join(root, "sessions.json"), JSON.stringify([target]));
		await writeFile(
			join(root, "agent-device", session, "daemon.json"),
			JSON.stringify({
				pid: process.pid,
				httpPort: 12345,
				token: "test-token",
			}),
		);
		const file = join(root, "launcher");
		await writeFile(
			file,
			simulatorLauncher({
				node: process.execPath,
				entry,
				root,
				owner,
				session,
				target,
				platform: "ios",
			}),
			{ mode: 0o700 },
		);
		const env = {
			...process.env,
			AGENT_DEVICE_DAEMON_BASE_URL: "http://wrong-host",
			AGENT_DEVICE_PLATFORM: "android",
			AGENT_DEVICE_CONFIG: "/wrong/config",
		};
		const result = JSON.parse(
			(await exec(file, ["snapshot", "-i"], { env })).stdout,
		);
		expect(result.endpoint).toBe("http://127.0.0.1:12345");
		expect(result.platform).toBeUndefined();
		expect(result.config).toBeUndefined();
		expect(result.args).toContain("ABC-123");
		expect(result.args).toContain("zuse-session");
		const help = JSON.parse((await exec(file, ["--help"], { env })).stdout);
		expect(help.args[0]).toBe("--help");
		await expect(exec(file, ["snapshot", "--udid", "other"])).rejects.toThrow(
			"managed by Zuse",
		);
		await writeFile(
			access,
			JSON.stringify({ enabled: true, owner: "new-owner", pid: process.pid }),
		);
		await expect(exec(file, ["snapshot"])).rejects.toThrow("access is off");
		await writeFile(
			access,
			JSON.stringify({ enabled: false, owner, pid: process.pid }),
		);
		await expect(exec(file, ["snapshot"])).rejects.toThrow("access is off");
		await writeFile(
			access,
			JSON.stringify({ enabled: true, owner, pid: process.pid }),
		);
		await writeFile(join(root, "sessions.json"), "[]");
		await expect(exec(file, ["snapshot"])).rejects.toThrow("session is closed");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
