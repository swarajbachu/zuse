import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";

import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import type { Socket as SocketNs } from "effect/unstable/socket";
import { Socket } from "effect/unstable/socket";

/**
 * WebSocket ↔ sshd bridge for cloud workspaces.
 *
 * There is no listening SSH daemon in the sandbox. Each authorized WebSocket
 * connection spawns `sshd -i` (single-connection inetd mode) and pipes frames
 * to its stdio. Access requires a relay-issued ticket: the relay stages the
 * ticket's SHA-256 hash and expiry in a sandbox file (like the runtime boot
 * token) and hands the plain ticket to the desktop's ProxyCommand bridge.
 */

const SSH_TICKET_FILE = "/home/zuse/.zuse-ssh-ticket";
const SSHD_BINARY = "/usr/sbin/sshd";
const SSHD_CONFIG_FILE = "/home/zuse/.ssh/sshd_config";

const sha256Hex = (value: string): string =>
	createHash("sha256").update(value).digest("hex");

/** Pure ticket check against the staged ticket file's contents. */
export const verifySshTicket = (
	ticket: string,
	ticketFileContents: string,
	nowMs: number,
): boolean => {
	let parsed: { tokenHash?: unknown; expiresAtMs?: unknown };
	try {
		parsed = JSON.parse(ticketFileContents) as typeof parsed;
	} catch {
		return false;
	}
	if (
		typeof parsed.tokenHash !== "string" ||
		typeof parsed.expiresAtMs !== "number" ||
		parsed.expiresAtMs <= nowMs
	)
		return false;
	const expected = Buffer.from(parsed.tokenHash, "hex");
	const received = Buffer.from(sha256Hex(ticket), "hex");
	return (
		expected.length === received.length && timingSafeEqual(expected, received)
	);
};

const ticketAuthorized = (ticket: string | null): Promise<boolean> =>
	ticket === null || ticket.length === 0
		? Promise.resolve(false)
		: readFile(SSH_TICKET_FILE, "utf8").then(
				(contents) => verifySshTicket(ticket, contents, Date.now()),
				() => false,
			);

const pumpSshd = (socket: SocketNs.Socket) =>
	Effect.scoped(
		Effect.gen(function* () {
			const write = yield* socket.writer;
			const child = yield* Effect.acquireRelease(
				Effect.sync(() =>
					spawn(SSHD_BINARY, ["-i", "-q", "-f", SSHD_CONFIG_FILE], {
						stdio: ["pipe", "pipe", "ignore"],
					}),
				),
				(sshd) =>
					Effect.sync(() => {
						if (sshd.exitCode === null) sshd.kill("SIGKILL");
					}),
			);
			const childExited = Effect.callback<void>((resume) => {
				if (child.exitCode !== null) {
					resume(Effect.void);
					return;
				}
				child.once("exit", () => resume(Effect.void));
			});
			child.once("error", () => child.kill("SIGKILL"));
			child.stdout.on("data", (chunk: Buffer) => {
				void Effect.runPromise(write(chunk)).catch(() => {
					child.kill("SIGKILL");
				});
			});
			yield* Effect.race(
				socket
					.runRaw((data) => {
						child.stdin.write(
							typeof data === "string" ? Buffer.from(data) : data,
						);
					})
					.pipe(Effect.catch(() => Effect.void)),
				childExited,
			);
			yield* write(new Socket.CloseEvent(1000)).pipe(
				Effect.catch(() => Effect.void),
			);
		}),
	);

export const sshBridgeApp = (
	log?: (event: string, fields?: Record<string, unknown>) => void,
) =>
	Effect.gen(function* () {
		const request = yield* HttpServerRequest.HttpServerRequest;
		if (request.headers.upgrade?.toLowerCase() !== "websocket")
			return yield* HttpServerResponse.json(
				{ error: "websocket_upgrade_required" },
				{ status: 400 },
			).pipe(Effect.orDie);
		const ticket = new URL(request.url, "http://localhost").searchParams.get(
			"ticket",
		);
		if (!(yield* Effect.promise(() => ticketAuthorized(ticket)))) {
			log?.("ssh.bridge.reject", { hasTicket: ticket !== null });
			return yield* HttpServerResponse.json(
				{ error: "unauthorized" },
				{ status: 401 },
			).pipe(Effect.orDie);
		}
		const socket = yield* request.upgrade.pipe(Effect.orDie);
		log?.("ssh.bridge.open");
		yield* pumpSshd(socket).pipe(Effect.catch(() => Effect.void));
		log?.("ssh.bridge.close");
		return HttpServerResponse.empty();
	});
