import { describe, expect, test } from "vitest";

import {
	cloudSshHostAlias,
	managedSshConfig,
	sshTargetLaunch,
	withUserConfigInclude,
} from "../../src/ssh/cloud-ssh-service.ts";

describe("cloud ssh service", () => {
	test("managed config wires the bridge as ProxyCommand for zuse-* hosts", () => {
		const config = managedSshConfig(
			'env ELECTRON_RUN_AS_NODE=1 "/app" "/b.cjs"',
		);
		expect(config).toContain("Host zuse-*");
		expect(config).toContain("User zuse");
		expect(config).toContain(
			'ProxyCommand env ELECTRON_RUN_AS_NODE=1 "/app" "/b.cjs" %n',
		);
		expect(config).toContain("IdentitiesOnly yes");
	});

	test("user config include is prepended once and only once", () => {
		const first = withUserConfigInclude(
			"Host other\n",
			"/home/u/.zuse/ssh/config",
		);
		expect(first).toContain("Include /home/u/.zuse/ssh/config");
		expect(first?.endsWith("Host other\n")).toBe(true);
		expect(
			withUserConfigInclude(first ?? "", "/home/u/.zuse/ssh/config"),
		).toBeNull();
	});

	test("ssh target launches", () => {
		const alias = cloudSshHostAlias("workspace_abc");
		expect(alias).toBe("zuse-workspace_abc");
		expect(sshTargetLaunch("cursor", alias, "/home/zuse/workspace")).toEqual({
			kind: "uri",
			uri: "cursor://vscode-remote/ssh-remote+zuse-workspace_abc/home/zuse/workspace",
		});
		expect(sshTargetLaunch("zed", alias, "/home/zuse/workspace")).toEqual({
			kind: "uri",
			uri: "zed://ssh/zuse@zuse-workspace_abc/home/zuse/workspace",
		});
		expect(sshTargetLaunch("terminal", alias, "/home/zuse/workspace")).toEqual({
			kind: "terminal",
			command: "ssh zuse-workspace_abc",
		});
		expect(sshTargetLaunch("unknown", alias, "/x")).toBeNull();
	});
});
