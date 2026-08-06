import { describe, expect, test } from "vitest";

import {
	mergeDiscoveredHosts,
	parseHostAliases,
	parseLaunchResult,
	parseSshGConfig,
	parseTailscaleStatus,
	remoteBootstrapScript,
	remoteLaunchScript,
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
		expect(() => remoteBootstrapScript("latest; rm -rf /")).toThrow(
			"Invalid compatible Serve runtime version",
		);
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
		expect(
			tunnelArgs({ host: "devbox", localPort: 3001, remotePort: 8787 }),
		).toContain("127.0.0.1:3001:127.0.0.1:8787");
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
