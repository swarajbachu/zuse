import { describe, expect, test } from "vitest";

import {
	mergeDiscoveredHosts,
	parseHostAliases,
	parseLaunchResult,
	parseSelfHostedCliEvent,
	parseSelfHostedPreflight,
	parseSshGConfig,
	parseTailscaleStatus,
	remoteBootstrapScript,
	remoteLaunchScript,
	SSH_MANAGED_SERVE_PORT,
	selfHostedBootstrapScript,
	selfHostedRemoteLaunchScript,
	sshGArgs,
	tunnelArgs,
	validateSshTargetSafety,
} from "../../src/index.ts";

describe("@zuse/ssh", () => {
	test("parses ssh -G output", () => {
		expect(
			parseSshGConfig(
				"devbox",
				"user alice\nhostname example.test\nport 2222\nidentityfile ~/.ssh/id_ed25519\n",
			),
		).toEqual({
			host: "devbox",
			hostname: "example.test",
			user: "alice",
			port: 2222,
			identityFile: "~/.ssh/id_ed25519",
		});
	});

	test("builds a version-pinned remote bootstrap without interpolating targets", () => {
		const script = remoteBootstrapScript("0.1.2");
		expect(script).toContain("@zusehq/serve@$VERSION");
		expect(script).toContain("--ssh-managed");
		expect(script).toContain("Node 22.5 or newer");
		expect(script).toContain("active.json");
		expect(script).toContain("unverified service");
		// Never share the default `zuse serve` port with the SSH-managed host.
		expect(script).toContain(`PORT="${SSH_MANAGED_SERVE_PORT}"`);
		expect(SSH_MANAGED_SERVE_PORT).not.toBe(4859);
		expect(script).toContain('serve start --ssh-managed --port "$PORT"');
		expect(() => remoteBootstrapScript("latest; rm -rf /")).toThrow(
			"Invalid compatible Serve runtime version",
		);
	});

	test("builds a pinned self-hosted installer and parses lifecycle output", () => {
		const script = selfHostedBootstrapScript("0.1.2");
		expect(script).toContain("@zusehq/serve@$VERSION");
		expect(script).toContain("SHASUMS256.txt");
		expect(script).toContain(
			"for prerequisite in git curl gh xz make g++ python3",
		);
		expect(script).toContain("xz-utils build-essential python3");
		expect(script).toContain("--self-hosted --json");
		expect(selfHostedRemoteLaunchScript).toContain(
			"systemctl --user start zuse-serve.service",
		);
		expect(() => selfHostedBootstrapScript("latest; touch /tmp/nope")).toThrow(
			"Invalid compatible Serve runtime version",
		);
		expect(
			parseSelfHostedCliEvent(
				'{"version":1,"type":"authorization_required","userCode":"ABCD-EFGH","verificationUri":"https://example.test"}',
			),
		).toMatchObject({ type: "authorization_required", userCode: "ABCD-EFGH" });
		expect(parseSelfHostedCliEvent("not-json")).toBeNull();
	});

	test.each([
		"x86_64",
		"arm64",
	])("accepts Ubuntu 26.04 on %s", (architecture) => {
		expect(
			parseSelfHostedPreflight(
				`os_id=ubuntu\nos_version=26.04\narchitecture=${architecture}\nhome=/root\ndisk_kib=35950428\nsystemd_user=1\nlinger=0\nsudo=1\nusername=root\n`,
			),
		).toMatchObject({ supported: true, architecture, blockingReason: null });
	});

	test("accepts only the guided Linux and architecture combinations", () => {
		expect(
			parseSelfHostedPreflight(
				"os_id=ubuntu\nos_version=24.04\narchitecture=arm64\nhome=/home/zuse\ndisk_kib=1024\nnode_version=v22\ngit_version=git version 2\nsystemd_user=1\nlinger=1\nsudo=0\nusername=zuse\n",
			),
		).toMatchObject({ supported: true, architecture: "arm64" });
		expect(
			parseSelfHostedPreflight(
				"os_id=alpine\nos_version=3.20\narchitecture=x86_64\nsystemd_user=1\nlinger=1\nsudo=0\nusername=zuse\n",
			),
		).toMatchObject({
			supported: false,
			blockingReason: "unsupported_linux_distribution",
		});
	});

	test("discovers online Tailnet peers and omits self and offline peers", () => {
		expect(
			parseTailscaleStatus(
				JSON.stringify({
					Self: { DNSName: "mac.tail.test.", TailscaleIPs: ["100.64.0.1"] },
					Peer: {
						one: {
							DNSName: "dev.tail.test.",
							HostName: "devbox",
							TailscaleIPs: ["100.64.0.2"],
							Online: true,
							OS: "linux",
						},
						two: {
							DNSName: "offline.tail.test.",
							TailscaleIPs: ["100.64.0.3"],
							Online: false,
						},
						self: {
							DNSName: "mac.tail.test.",
							TailscaleIPs: ["100.64.0.1"],
							Online: true,
						},
					},
				}),
			),
		).toEqual([
			{
				alias: "dev.tail.test",
				hostname: "dev.tail.test",
				username: null,
				port: null,
				source: "tailscale",
				online: true,
				os: "linux",
				displayName: "devbox",
			},
		]);
	});

	test("rejects malformed Tailnet output and deduplicates SSH aliases", () => {
		expect(() => parseTailscaleStatus("not json")).toThrow();
		expect(
			mergeDiscoveredHosts(
				["dev.tail.test"],
				[
					{
						alias: "dev.tail.test",
						hostname: "dev.tail.test",
						username: null,
						port: null,
						source: "tailscale",
						online: true,
						os: "linux",
						displayName: "devbox",
					},
				],
			),
		).toEqual([
			{
				alias: "dev.tail.test",
				hostname: "dev.tail.test",
				username: null,
				port: null,
				source: "ssh-config",
				online: null,
				os: null,
				displayName: "dev.tail.test",
			},
		]);
	});

	test("discovers concrete Host aliases only", () => {
		expect(
			parseHostAliases("Host dev prod-*\n  User alice\nHost !bad staging\n"),
		).toEqual(["dev", "staging"]);
	});

	test("builds native ssh commands", () => {
		expect(sshGArgs("devbox")).toEqual(["-G", "devbox"]);
		const args = tunnelArgs({
			host: "devbox",
			localPort: 3001,
			remotePort: 8787,
		});
		expect(args).toContain("127.0.0.1:3001:127.0.0.1:8787");
		expect(args).toContain("ExitOnForwardFailure=yes");
		expect(args).not.toContain("-F");
	});

	test("resolves tunnel aliases against a dedicated ssh config", () => {
		const args = tunnelArgs({
			host: "zuse-workspace",
			localPort: 3000,
			remotePort: 3000,
			configFile: "/home/user/.zuse/ssh/config",
		});
		expect(args.slice(0, 2)).toEqual(["-F", "/home/user/.zuse/ssh/config"]);
		expect(args.at(-1)).toBe("zuse-workspace");
	});

	test("rejects SSH option and username injection", () => {
		expect(() =>
			validateSshTargetSafety({
				alias: "-oProxyCommand=bad",
				hostname: "host",
				username: null,
				port: null,
			}),
		).toThrow(/unsupported characters/u);
		expect(() =>
			validateSshTargetSafety({
				alias: "host",
				hostname: "host",
				username: "user\n-oBad",
				port: 22,
			}),
		).toThrow(/username/u);
	});

	test("emits and parses launch response contract", () => {
		expect(remoteLaunchScript()).toContain("serverKind");
		expect(
			parseLaunchResult('{"remotePort":8787,"serverKind":"zuse"}'),
		).toEqual({ remotePort: 8787, serverKind: "zuse" });
	});
});
