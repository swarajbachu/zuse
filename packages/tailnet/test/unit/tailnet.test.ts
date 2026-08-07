import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	authorizeTailnetOperator,
	extractTailnetApprovalUrl,
	inspectTailnetShare,
	isTailnetOperatorPermissionError,
	makeTailnetCommandRunner,
	parseTailnetStatus,
	resolveTailnetExecutable,
	serveStatusIsExclusive,
	serveStatusMatches,
	setTailnetShareEnabled,
	type TailnetCommandResult,
	tailnetCommandEnvironment,
	tailnetOutputHint,
} from "../../src/index.ts";

const result = (
	stdout: string,
	code = 0,
	stderr = "",
): TailnetCommandResult => ({ stdout, stderr, code });

describe("tailnet sharing", () => {
	it("uses the packaged macOS CLI when it is installed", () => {
		expect(resolveTailnetExecutable("darwin", () => true)).toBe(
			"/Applications/Tailscale.app/Contents/MacOS/Tailscale",
		);
		expect(resolveTailnetExecutable("linux", () => true)).toBe("tailscale");
	});
	it("parses a running node and normalizes MagicDNS", () => {
		expect(
			parseTailnetStatus(
				JSON.stringify({
					BackendState: "Running",
					Self: { DNSName: "Build-Box.Example.ts.net." },
				}),
			),
		).toEqual({
			backendState: "Running",
			dnsName: "build-box.example.ts.net",
		});
	});

	it("only accepts the Tailscale Serve feature approval URL", () => {
		expect(
			extractTailnetApprovalUrl(
				"To enable, visit:\nhttps://login.tailscale.com/f/serve?node=example",
			),
		).toBe("https://login.tailscale.com/f/serve?node=example");
		expect(
			extractTailnetApprovalUrl(
				"Approve at https://login.tailscale.com/admin/feature/serve?node=example",
			),
		).toBe("https://login.tailscale.com/admin/feature/serve?node=example");
		expect(
			extractTailnetApprovalUrl("Open https://example.com/admin/feature/serve"),
		).toBeNull();
	});

	it("forces the bundled macOS app executable into CLI mode", () => {
		expect(
			tailnetCommandEnvironment({
				PATH: "/usr/bin",
				TAILSCALE_BE_CLI: "0",
			}),
		).toMatchObject({
			PATH: "/usr/bin",
			TAILSCALE_BE_CLI: "1",
		});
	});

	it("classifies command failures without retaining their raw output", () => {
		expect(
			tailnetOutputHint("", "operation not permitted for user alice"),
		).toBe("permission-denied");
		expect(tailnetOutputHint("", "failed to connect to local daemon")).toBe(
			"daemon-unavailable",
		);
		expect(tailnetOutputHint("", "not logged in")).toBe("signed-out");
	});

	it("recognizes the Linux operator permission failure", () => {
		expect(
			isTailnetOperatorPermissionError(
				"sending serve config: Access denied: serve config denied Use 'sudo tailscale serve --bg --yes 127.0.0.1:8788'. To not require root, use 'sudo tailscale set --operator=$USER' once.",
			),
		).toBe(true);
		expect(
			isTailnetOperatorPermissionError("Tailscale Serve is already configured"),
		).toBe(false);
	});

	it("authorizes the current Linux user through a graphical privilege prompt", async () => {
		const calls: Array<{
			readonly args: ReadonlyArray<string>;
			readonly timeoutMs?: number;
		}> = [];
		const authorization = await authorizeTailnetOperator(
			{
				username: "alice",
				platform: "linux",
				canExecute: (path) =>
					path === "/usr/bin/pkexec" || path === "/usr/bin/tailscale",
			},
			async (args, timeoutMs) => {
				calls.push({ args, timeoutMs });
				return result("");
			},
		);

		expect(authorization).toEqual({
			authorized: true,
			manualCommand: "sudo tailscale set --operator=$USER",
			detail: null,
		});
		expect(calls).toEqual([
			{
				args: ["/usr/bin/tailscale", "set", "--operator=alice"],
				timeoutMs: 120_000,
			},
		]);
	});

	it("falls back to the one-time command when no privilege prompt exists", async () => {
		await expect(
			authorizeTailnetOperator({
				username: "alice",
				platform: "linux",
				canExecute: () => false,
			}),
		).resolves.toEqual({
			authorized: false,
			manualCommand: "sudo tailscale set --operator=$USER",
			detail: "A graphical administrator prompt is unavailable.",
		});
	});

	it("stops a waiting Serve command as soon as it prints an approval URL", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-test-"));
		const executable = join(directory, "tailscale-fixture.mjs");
		await writeFile(
			executable,
			`#!/usr/bin/env node
process.stdout.write("Enable Serve at https://login.tailscale.com/f/serve?node=example\\n");
setInterval(() => undefined, 10_000);
`,
			{ mode: 0o700 },
		);
		await chmod(executable, 0o700);
		const startedAt = Date.now();
		const diagnostics: Array<{
			readonly event: string;
			readonly command: string;
		}> = [];
		try {
			const output = await makeTailnetCommandRunner(
				(event) => diagnostics.push(event),
				executable,
			)(["serve", "--bg", "--yes", "127.0.0.1:47837"], 2_000);
			expect(output.approvalUrl).toBe(
				"https://login.tailscale.com/f/serve?node=example",
			);
			expect(Date.now() - startedAt).toBeLessThan(1_800);
			expect(diagnostics).toEqual([
				expect.objectContaining({
					event: "start",
					command: "serve-enable",
					timeoutMs: 2_000,
				}),
				expect.objectContaining({
					event: "approval",
					command: "serve-enable",
					outputHint: "serve-configuration",
				}),
			]);
			expect(JSON.stringify(diagnostics)).not.toContain("login.tailscale.com");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("recognizes the managed loopback target", () => {
		expect(
			serveStatusMatches(
				"https://build.ts.net\n|-- / proxy http://127.0.0.1:47837",
				47837,
			),
		).toBe(true);
		expect(serveStatusMatches("No serve config", 47837)).toBe(false);
	});

	it("only claims an exclusive root Serve route", () => {
		expect(
			serveStatusIsExclusive(
				"https://build.ts.net\n|-- / proxy http://127.0.0.1:47837",
				47837,
			),
		).toBe(true);
		expect(
			serveStatusIsExclusive(
				"https://build.ts.net\n|-- / proxy http://127.0.0.1:47837\n|-- /docs proxy http://127.0.0.1:9000",
				47837,
			),
		).toBe(false);
	});

	it("treats a missing CLI as unavailable", async () => {
		const state = await inspectTailnetShare(47837, async () => {
			throw Object.assign(new Error("spawn tailscale ENOENT"), {
				code: "ENOENT",
			});
		});
		expect(state.availability).toBe("not-installed");
		expect(state.enabled).toBe(false);
	});

	it("enables the persistent HTTPS proxy", async () => {
		const calls: ReadonlyArray<string>[] = [];
		let sharing = false;
		const run = async (args: ReadonlyArray<string>) => {
			calls.push(args);
			if (args[0] === "status") {
				return result(
					JSON.stringify({
						BackendState: "Running",
						Self: { DNSName: "box.example.ts.net." },
					}),
				);
			}
			if (args.includes("--bg")) {
				sharing = true;
				return result("");
			}
			return result(
				sharing
					? "https://box.example.ts.net\n|-- / proxy http://127.0.0.1:47837"
					: "No serve config",
			);
		};
		const state = await setTailnetShareEnabled(
			{ enabled: true, port: 47837 },
			run,
		);
		expect(state.enabled).toBe(true);
		expect(state.httpsUrl).toBe("https://box.example.ts.net");
		expect(calls).toContainEqual(["serve", "--bg", "--yes", "127.0.0.1:47837"]);
	});

	it("returns the first-use approval URL instead of a command timeout", async () => {
		const approvalUrl = "https://login.tailscale.com/f/serve?node=example";
		const run = async (args: ReadonlyArray<string>) => {
			if (args[0] === "status") {
				return result(
					JSON.stringify({
						BackendState: "Running",
						Self: { DNSName: "box.example.ts.net." },
					}),
				);
			}
			if (args.includes("--bg")) {
				return {
					...result(`Enable Tailscale Serve:\n${approvalUrl}`, 124),
					approvalUrl,
					timedOut: true,
				};
			}
			return result("No serve config");
		};

		const state = await setTailnetShareEnabled(
			{ enabled: true, port: 47837 },
			run,
		);

		expect(state.availability).toBe("approval-required");
		expect(state.approvalUrl).toBe(approvalUrl);
		expect(state.detail).toMatch(/approve/iu);
	});

	it("does not replace an existing Serve configuration", async () => {
		const calls: ReadonlyArray<string>[] = [];
		const run = async (args: ReadonlyArray<string>) => {
			calls.push(args);
			return args[0] === "status"
				? result(
						JSON.stringify({
							BackendState: "Running",
							Self: { DNSName: "box.example.ts.net." },
						}),
					)
				: result(
						"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:9000",
					);
		};
		const state = await setTailnetShareEnabled(
			{ enabled: true, port: 47837 },
			run,
		);
		expect(state.availability).toBe("error");
		expect(state.detail).toMatch(/already configured/u);
		expect(calls).not.toContainEqual([
			"serve",
			"--bg",
			"--yes",
			"127.0.0.1:47837",
		]);
	});

	it("does not disable a shared Serve configuration", async () => {
		const calls: ReadonlyArray<string>[] = [];
		const run = async (args: ReadonlyArray<string>) => {
			calls.push(args);
			return args[0] === "status"
				? result(
						JSON.stringify({
							BackendState: "Running",
							Self: { DNSName: "box.example.ts.net." },
						}),
					)
				: result(
						"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:47837\n|-- /docs proxy http://127.0.0.1:9000",
					);
		};
		const state = await setTailnetShareEnabled(
			{ enabled: false, port: 47837 },
			run,
		);
		expect(state.availability).toBe("error");
		expect(state.detail).toMatch(/additional routes/u);
		expect(calls).not.toContainEqual(["serve", "--https=443", "off"]);
	});
});
