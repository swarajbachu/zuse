import { describe, expect, it } from "vitest";

import {
	launchAgentDefinition,
	systemdUserDefinition,
} from "../../src/serve/service-definition.ts";

describe("Zuse Serve service definitions", () => {
	it("creates a restartable macOS LaunchAgent without embedding credentials", () => {
		const definition = launchAgentDefinition({
			nodeExecutable: "/opt/node/bin/node",
			executable: "/opt/zuse/bin/zuse",
			dataDir: "/Users/dev/.local/share/zuse",
			logDir: "/Users/dev/Library/Logs/Zuse",
			relayUrl: "http://127.0.0.1:8790",
		});

		expect(definition.label).toBe("sh.zuse.serve");
		expect(definition.contents).toContain("<string>serve</string>");
		expect(definition.contents).toContain("<string>--foreground</string>");
		expect(definition.contents).toContain(
			"<string>/Users/dev/.local/share/zuse</string>",
		);
		expect(definition.contents).toContain("<key>KeepAlive</key>");
		expect(definition.contents).toContain(
			"<string>http://127.0.0.1:8790</string>",
		);
		expect(definition.contents).not.toMatch(/token|credential|authorization/iu);
	});

	it("creates a hardened Linux systemd user service", () => {
		const definition = systemdUserDefinition({
			nodeExecutable: "/opt/node/bin/node",
			executable: "/home/dev/.local/bin/zuse",
			dataDir: "/home/dev/.local/share/zuse",
		});

		expect(definition.unitName).toBe("zuse-serve.service");
		expect(definition.contents).toContain(
			'ExecStart="/opt/node/bin/node" "/home/dev/.local/bin/zuse" serve --foreground --data-dir "/home/dev/.local/share/zuse"',
		);
		expect(definition.contents).toContain("Restart=on-failure");
		expect(definition.contents).toContain("NoNewPrivileges=true");
		expect(definition.contents).not.toMatch(/token|credential|authorization/iu);
	});

	it("creates a credential-free SSH-managed service", () => {
		const input = {
			nodeExecutable: "/opt/node/bin/node",
			executable: "/opt/zuse/bin/zuse",
			dataDir: "/home/dev/.local/share/zuse",
			sshManaged: true,
		};

		const launchAgent = launchAgentDefinition(input);
		const systemd = systemdUserDefinition(input);

		expect(launchAgent.contents).toContain("<string>--ssh-managed</string>");
		expect(systemd.contents).toContain(" --ssh-managed");
		expect(launchAgent.contents).not.toContain("ZUSE_SERVE_AUTO_LINK");
		expect(systemd.contents).not.toContain("ZUSE_SERVE_AUTO_LINK");
	});
});
