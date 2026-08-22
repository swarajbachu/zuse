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
		expect(systemd.contents).toContain(' "--ssh-managed"');
		expect(launchAgent.contents).not.toContain("ZUSE_SERVE_AUTO_LINK");
		expect(systemd.contents).not.toContain("ZUSE_SERVE_AUTO_LINK");
	});

	it("keeps the account relay active alongside Tailnet sharing", () => {
		const input = {
			nodeExecutable: "/opt/node/bin/node",
			executable: "/opt/zuse/bin/zuse",
			dataDir: "/home/dev/.local/share/zuse",
			tailscale: true,
		};
		const launchAgent = launchAgentDefinition(input);
		const systemd = systemdUserDefinition(input);
		expect(launchAgent.contents).toContain("<string>--tailscale</string>");
		expect(systemd.contents).toContain(' "--tailscale"');
		expect(launchAgent.contents).toContain("ZUSE_SERVE_AUTO_LINK");
		expect(systemd.contents).toContain("ZUSE_SERVE_AUTO_LINK");
	});

	it("disables the account relay only on explicit opt-out", () => {
		const input = {
			nodeExecutable: "/opt/node/bin/node",
			executable: "/opt/zuse/bin/zuse",
			dataDir: "/home/dev/.local/share/zuse",
			tailscale: true,
			noAccount: true,
		};
		const launchAgent = launchAgentDefinition(input);
		const systemd = systemdUserDefinition(input);
		expect(launchAgent.contents).toContain("<string>--no-account</string>");
		expect(systemd.contents).toContain(' "--no-account"');
		expect(launchAgent.contents).not.toContain("ZUSE_SERVE_AUTO_LINK");
		expect(systemd.contents).not.toContain("ZUSE_SERVE_AUTO_LINK");
	});

	it("persists LAN binding flags in the service definition", () => {
		const input = {
			nodeExecutable: "/opt/node/bin/node",
			executable: "/opt/zuse/bin/zuse",
			dataDir: "/home/dev/.local/share/zuse",
			lan: true,
			port: 5000,
		};
		const launchAgent = launchAgentDefinition(input);
		const systemd = systemdUserDefinition(input);
		expect(launchAgent.contents).toContain("<string>--lan</string>");
		expect(launchAgent.contents).toContain("<string>--port</string>");
		expect(launchAgent.contents).toContain("<string>5000</string>");
		expect(systemd.contents).toContain(' "--lan" "--port" "5000" ');

		const hostBound = systemdUserDefinition({
			...input,
			lan: false,
			host: "192.168.1.50",
		});
		expect(hostBound.contents).toContain(
			' "--host" "192.168.1.50" "--port" "5000" ',
		);
	});
});
