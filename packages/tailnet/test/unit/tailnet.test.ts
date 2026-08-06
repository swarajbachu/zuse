import { describe, expect, it } from "vitest";

import {
	inspectTailnetShare,
	parseTailnetStatus,
	resolveTailnetExecutable,
	serveStatusIsExclusive,
	serveStatusMatches,
	setTailnetShareEnabled,
	type TailnetCommandResult,
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
