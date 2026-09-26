import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";

import { Effect } from "effect";
import { Socket } from "effect/unstable/socket";
import { describe, expect, test, vi } from "vitest";

import { pumpSshd, verifySshTicket } from "../../src/transports/ssh-bridge.ts";

const sha256Hex = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

const NOW = 1_000_000;
const TICKET = "workspace_ssh_abc123";

const ticketFile = (overrides: Record<string, unknown> = {}): string =>
	JSON.stringify({
		tokenHash: sha256Hex(TICKET),
		expiresAtMs: NOW + 60_000,
		...overrides,
	});

describe("ssh bridge ticket verification", () => {
	test("accepts a matching, unexpired ticket", () => {
		expect(verifySshTicket(TICKET, ticketFile(), NOW)).toBe(true);
	});

	test.each([
		["wrong ticket", "workspace_ssh_other", ticketFile()],
		["expired ticket", TICKET, ticketFile({ expiresAtMs: NOW })],
		["invalid JSON", TICKET, "not json"],
		["missing fields", TICKET, "{}"],
		["invalid hash type", TICKET, ticketFile({ tokenHash: 42 })],
		["invalid hash", TICKET, ticketFile({ tokenHash: "zz-not-hex" })],
	])("rejects %s", (_case, ticket, contents) => {
		expect(verifySshTicket(ticket, contents, NOW)).toBe(false);
	});
});

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));

describe("ssh bridge cleanup", () => {
	test.each([
		"peer",
		"child",
	] as const)("releases the bridge when %s closes first", async (winner) => {
		const child = Object.assign(new EventEmitter(), {
			exitCode: null as number | null,
			stdin: { write: vi.fn() },
			stdout: new EventEmitter(),
			kill: vi.fn(() => true),
		});
		spawnMock.mockReturnValueOnce(child);
		const ws = Object.assign(new EventTarget(), {
			readyState: 1,
			send: vi.fn(),
			close: vi.fn(),
		});
		let released = false;
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					// Use the real Effect socket so runRaw's write-latch lifecycle is
					// exercised, including interruption when the child wins the race.
					const socket = yield* Socket.fromWebSocket(
						Effect.acquireRelease(
							Effect.succeed(ws as unknown as WebSocket),
							() =>
								Effect.sync(() => {
									ws.close();
									released = true;
								}),
						),
					);
					yield* pumpSshd({
						...socket,
						runRaw: (handler, options) =>
							socket.runRaw(handler, {
								...options,
								onOpen: Effect.sync(() => {
									if (winner === "peer") {
										ws.dispatchEvent(
											Object.assign(new Event("close"), {
												code: 1000,
												reason: "",
											}),
										);
									} else {
										child.exitCode = 0;
										child.emit("exit", 0);
									}
								}),
							}),
					});
				}),
			).pipe(Effect.timeout("1 second")),
		);
		expect(released).toBe(true);
		expect(ws.close).toHaveBeenCalledTimes(1);
		if (winner === "peer") expect(child.kill).toHaveBeenCalledWith("SIGKILL");
		else expect(child.kill).not.toHaveBeenCalled();
	});
});
