import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	authorizeTailnetOperator,
	clearServeOwnershipMarker,
	extractTailnetApprovalUrl,
	inspectTailnetShare,
	isTailnetOperatorPermissionError,
	makeTailnetCommandRunner,
	parseServeProxyTargets,
	parseTailnetStatus,
	probeZuseLoopback,
	readServeOwnershipMarker,
	repairTailnetShare,
	resolveServeOwnership,
	resolveTailnetExecutable,
	serveStatusIsExclusive,
	serveStatusMatches,
	setTailnetShareEnabled,
	type TailnetCommandResult,
	tailnetCommandEnvironment,
	tailnetOutputHint,
	writeServeOwnershipMarker,
	type ZuseIdentityProbe,
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

	it("reports a live foreign Serve configuration as a conflict", async () => {
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
			{ enabled: true, port: 47837, probe: async () => "other" },
			run,
		);
		expect(state.availability).toBe("conflict");
		expect(state.conflict).toMatchObject({
			reason: "foreign-app",
			targetPort: 9000,
			canReplace: true,
		});
		expect(state.detail).toMatch(/another app/u);
		expect(calls).not.toContainEqual([
			"serve",
			"--bg",
			"--yes",
			"127.0.0.1:47837",
		]);
	});

	it("replaces a foreign configuration only when explicitly asked", async () => {
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
					: "https://box.example.ts.net\n|-- / proxy http://127.0.0.1:9000",
			);
		};
		const state = await setTailnetShareEnabled(
			{
				enabled: true,
				port: 47837,
				replaceExisting: true,
				probe: async () => "other",
			},
			run,
		);
		expect(state.enabled).toBe(true);
		expect(state.managedBy).toBe("this-app");
		expect(calls).toContainEqual(["serve", "--bg", "--yes", "127.0.0.1:47837"]);
	});

	it("reclaims a route whose owner is no longer responding", async () => {
		let sharing = false;
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
				sharing = true;
				return result("");
			}
			return result(
				sharing
					? "https://box.example.ts.net\n|-- / proxy http://127.0.0.1:47837"
					: "https://box.example.ts.net\n|-- / proxy http://127.0.0.1:9000",
			);
		};
		const state = await setTailnetShareEnabled(
			{ enabled: true, port: 47837, probe: async () => "unreachable" },
			run,
		);
		expect(state.enabled).toBe(true);
		expect(state.managedBy).toBe("this-app");
	});

	it("treats a live zuse serve route as enabled and never steals it", async () => {
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
						"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:4859",
					);
		};
		const state = await setTailnetShareEnabled(
			{ enabled: true, port: 47837, probe: async () => "zuse" },
			run,
		);
		expect(state.enabled).toBe(true);
		expect(state.managedBy).toBe("zuse-serve");
		expect(state.httpsUrl).toBe("https://box.example.ts.net");
		expect(calls.some((args) => args.includes("--bg"))).toBe(false);
	});

	it("refuses to disable a route managed by zuse serve", async () => {
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
						"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:4859",
					);
		};
		const state = await setTailnetShareEnabled(
			{ enabled: false, port: 47837, probe: async () => "zuse" },
			run,
		);
		expect(state.availability).toBe("error");
		expect(state.detail).toMatch(/zuse serve/u);
		expect(calls).not.toContainEqual(["serve", "--https=443", "off"]);
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

describe("serve status parsing", () => {
	it("extracts loopback proxy targets from serve output", () => {
		expect(
			parseServeProxyTargets(
				"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:47837\n|-- /docs proxy http://localhost:9000",
			),
		).toEqual([
			{ host: "127.0.0.1", port: 47837 },
			{ host: "localhost", port: 9000 },
		]);
		expect(parseServeProxyTargets("No serve config")).toEqual([]);
		expect(parseServeProxyTargets("")).toEqual([]);
		expect(parseServeProxyTargets("wholly unexpected output")).toEqual([]);
	});

	it("never matches a port by prefix", () => {
		const raw =
			"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:47837";
		expect(serveStatusMatches(raw, 4783)).toBe(false);
		expect(serveStatusMatches(raw, 478)).toBe(false);
		expect(serveStatusMatches(raw, 47837)).toBe(true);
	});
});

describe("serve ownership", () => {
	const running =
		"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:9000";
	const neverProbe: ZuseIdentityProbe = async () => {
		throw new Error("probe must not run");
	};

	it("resolves each ownership kind", async () => {
		await expect(
			resolveServeOwnership({
				serveStatusRaw: "No serve config",
				requestedPort: 47837,
				markerPort: null,
				probe: neverProbe,
			}),
		).resolves.toEqual({ kind: "none" });
		await expect(
			resolveServeOwnership({
				serveStatusRaw: "|-- / proxy something-unexpected",
				requestedPort: 47837,
				markerPort: null,
				probe: neverProbe,
			}),
		).resolves.toEqual({ kind: "unrecognized" });
		await expect(
			resolveServeOwnership({
				serveStatusRaw: running,
				requestedPort: 9000,
				markerPort: null,
				probe: neverProbe,
			}),
		).resolves.toEqual({ kind: "active" });
		await expect(
			resolveServeOwnership({
				serveStatusRaw: running,
				requestedPort: 47837,
				markerPort: 9000,
				probe: neverProbe,
			}),
		).resolves.toEqual({ kind: "repair", previousPort: 9000 });
		await expect(
			resolveServeOwnership({
				serveStatusRaw: running,
				requestedPort: 47837,
				markerPort: null,
				probe: async () => "zuse",
			}),
		).resolves.toEqual({ kind: "zuse-daemon", port: 9000 });
		await expect(
			resolveServeOwnership({
				serveStatusRaw: running,
				requestedPort: 47837,
				markerPort: null,
				probe: async () => "unreachable",
			}),
		).resolves.toEqual({ kind: "dead-target", port: 9000 });
		await expect(
			resolveServeOwnership({
				serveStatusRaw: running,
				requestedPort: 47837,
				markerPort: null,
				probe: async () => "other",
			}),
		).resolves.toEqual({ kind: "foreign", port: 9000 });
	});

	it("prefers the ownership marker over a live squatter on the old port", async () => {
		// A foreign process on the old port is why the relay port drifted in the
		// first place; the serve route still belongs to Zuse.
		await expect(
			resolveServeOwnership({
				serveStatusRaw: running,
				requestedPort: 47837,
				markerPort: 9000,
				probe: async () => "other",
			}),
		).resolves.toEqual({ kind: "repair", previousPort: 9000 });
	});

	it("round-trips the ownership marker", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-marker-"));
		try {
			await expect(readServeOwnershipMarker(directory)).resolves.toBeNull();
			await writeServeOwnershipMarker(directory, 47838);
			await expect(readServeOwnershipMarker(directory)).resolves.toBe(47838);
			await clearServeOwnershipMarker(directory);
			await expect(readServeOwnershipMarker(directory)).resolves.toBeNull();
			await writeFile(join(directory, "tailnet-serve.json"), "not json");
			await expect(readServeOwnershipMarker(directory)).resolves.toBeNull();
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("repairs a drifted route it owns and rewrites the marker", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-repair-"));
		try {
			await writeServeOwnershipMarker(directory, 47837);
			const calls: ReadonlyArray<string>[] = [];
			let servedPort = 47837;
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
					servedPort = 47838;
					return result("");
				}
				return result(
					`https://box.example.ts.net\n|-- / proxy http://127.0.0.1:${servedPort}`,
				);
			};
			const state = await repairTailnetShare(
				47838,
				{ ownershipDir: directory, probe: neverProbe },
				run,
			);
			expect(state.enabled).toBe(true);
			expect(state.managedBy).toBe("this-app");
			expect(calls).toContainEqual([
				"serve",
				"--bg",
				"--yes",
				"127.0.0.1:47838",
			]);
			await expect(readServeOwnershipMarker(directory)).resolves.toBe(47838);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("does not repair states it does not own", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-norepair-"));
		try {
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
			const state = await repairTailnetShare(
				47838,
				{ ownershipDir: directory, probe: async () => "other" },
				run,
			);
			expect(state.availability).toBe("conflict");
			expect(calls.some((args) => args.includes("--bg"))).toBe(false);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("writes the marker opportunistically for a pre-marker active route", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-tailnet-adopt-"));
		try {
			const run = async (args: ReadonlyArray<string>) =>
				args[0] === "status"
					? result(
							JSON.stringify({
								BackendState: "Running",
								Self: { DNSName: "box.example.ts.net." },
							}),
						)
					: result(
							"https://box.example.ts.net\n|-- / proxy http://127.0.0.1:47837",
						);
			const state = await inspectTailnetShare(47837, run, {
				ownershipDir: directory,
				probe: neverProbe,
			});
			expect(state.enabled).toBe(true);
			await expect(readServeOwnershipMarker(directory)).resolves.toBe(47837);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});

describe("probeZuseLoopback", () => {
	const listen = async (
		handler: import("node:http").RequestListener,
	): Promise<{ port: number; close: () => Promise<void> }> => {
		const { createServer } = await import("node:http");
		const server = createServer(handler);
		await new Promise<void>((resolve) =>
			server.listen(0, "127.0.0.1", resolve),
		);
		const address = server.address();
		if (address === null || typeof address === "string") {
			throw new Error("expected a bound port");
		}
		return {
			port: address.port,
			close: () =>
				new Promise<void>((resolve, reject) =>
					server.close((cause) =>
						cause === undefined ? resolve() : reject(cause),
					),
				),
		};
	};

	it("recognizes a Zuse identity endpoint", async () => {
		const server = await listen((request, response) => {
			if (request.method === "POST" && request.url === "/pair/identity") {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ publicKey: "pk", signature: "sig" }));
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		try {
			await expect(probeZuseLoopback(server.port)).resolves.toBe("zuse");
		} finally {
			await server.close();
		}
	});

	it("falls back to the session endpoint for older daemons", async () => {
		const server = await listen((request, response) => {
			if (request.method === "GET" && request.url === "/auth/session") {
				response.setHeader("content-type", "application/json");
				response.end(
					JSON.stringify({ authenticated: false, authRequired: true }),
				);
				return;
			}
			response.statusCode = 404;
			response.end();
		});
		try {
			await expect(probeZuseLoopback(server.port)).resolves.toBe("zuse");
		} finally {
			await server.close();
		}
	});

	it("classifies non-Zuse servers and dead ports", async () => {
		const server = await listen((_request, response) => {
			response.statusCode = 404;
			response.end("not here");
		});
		const deadPort = server.port;
		try {
			await expect(probeZuseLoopback(server.port)).resolves.toBe("other");
		} finally {
			await server.close();
		}
		await expect(probeZuseLoopback(deadPort)).resolves.toBe("unreachable");
	});
});
