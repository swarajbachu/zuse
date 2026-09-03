import { DatabaseSync } from "node:sqlite";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
	AgentSessionId,
	CloudCommandEnvelope,
	CommandId,
} from "@zuse/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceMailbox } from "../../src/workspace-mailbox.ts";

const makeMailbox = () => {
	const database = new DatabaseSync(":memory:");
	let alarm: number | null = null;
	const sql = {
		exec: <Row>(query: string, ...bindings: Array<string | number>) => {
			const rows = database.prepare(query).all(...bindings) as Row[];
			return { toArray: () => rows };
		},
	};
	const state = {
		storage: {
			sql,
			transactionSync: <Value>(run: () => Value) => {
				database.exec("BEGIN IMMEDIATE");
				try {
					const value = run();
					database.exec("COMMIT");
					return value;
				} catch (cause) {
					database.exec("ROLLBACK");
					throw cause;
				}
			},
			getAlarm: async () => alarm,
			setAlarm: async (value: number) => {
				alarm = value;
			},
		},
	} as unknown as DurableObjectState;
	return new WorkspaceMailbox(state);
};

const envelope = (commandId: string, sessionId = "session-1") =>
	CloudCommandEnvelope.make({
		protocolVersion: 3,
		workspaceId: "workspace-1",
		sessionId: AgentSessionId.make(sessionId),
		commandId: CommandId.make(commandId),
		kind: "messages.send",
		fingerprint: `hmac-sha256:${commandId}`,
		schemaVersion: 1,
		keyVersion: 1,
		destructionFence: 0,
		createdAt: Date.now(),
		iv: "iv",
		ciphertext: "ciphertext",
		dependencies: [],
	});

const call = (mailbox: WorkspaceMailbox, path: string, body?: unknown) =>
	mailbox.fetch(
		new Request(`https://mailbox.test${path}`, {
			method: body === undefined ? "GET" : "POST",
			...(body === undefined
				? {}
				: {
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
		}),
	);

describe("workspace mailbox", () => {
	afterEach(() => vi.useRealTimers());

	test("acceptance is idempotent and rejects identity collisions", async () => {
		const mailbox = makeMailbox();
		const command = envelope("command-1");
		expect((await call(mailbox, "/reserve", command)).status).toBe(200);
		const accepted = await call(mailbox, "/commit", {
			commandId: command.commandId,
		});
		expect(accepted.status).toBe(202);
		expect((await accepted.json()).state).toBe("accepted");
		expect((await call(mailbox, "/reserve", command)).status).toBe(200);
		expect(
			(
				await call(mailbox, "/reserve", {
					...command,
					fingerprint: "hmac-sha256:different",
				})
			).status,
		).toBe(409);
	});

	test("an enqueue retry observes an already terminal command", async () => {
		const mailbox = makeMailbox();
		const command = envelope("command-1");
		await call(mailbox, "/reserve", command);
		await call(mailbox, "/commit", { commandId: command.commandId });
		const leased = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
			})
		).json();
		await call(mailbox, "/ack", {
			commandId: command.commandId,
			leaseToken: leased.leases[0].leaseToken,
			fingerprint: command.fingerprint,
			state: "applied",
		});
		const before = await (
			await call(mailbox, "/status?commandId=command-1")
		).json();
		await call(mailbox, "/reserve", command);
		const retried = await call(mailbox, "/commit", {
			commandId: command.commandId,
		});
		const acceptance = await retried.json();
		const after = await (
			await call(mailbox, "/status?commandId=command-1")
		).json();
		expect(acceptance.state).toBe("accepted");
		expect(acceptance.revision).toBe(before.revision);
		expect(after.revision).toBe(before.revision);
		expect(after.state).toBe("applied");
	});

	test("leases only a lane head and advances after a matching receipt", async () => {
		const mailbox = makeMailbox();
		for (const id of ["command-1", "command-2"]) {
			await call(mailbox, "/reserve", envelope(id));
			await call(mailbox, "/commit", { commandId: id });
		}
		const first = (await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
			})
		).json()) as {
			leases: Array<{ command: { commandId: string }; leaseToken: string }>;
		};
		expect(first.leases.map((lease) => lease.command.commandId)).toEqual([
			"command-1",
		]);
		await call(mailbox, "/ack", {
			commandId: "command-1",
			leaseToken: first.leases[0]?.leaseToken,
			fingerprint: "hmac-sha256:command-1",
			state: "applied",
		});
		const second = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
			})
		).json();
		expect(second.leases[0].command.commandId).toBe("command-2");
	});

	test("cancels only commands that have never been leased", async () => {
		const mailbox = makeMailbox();
		for (const id of ["queued-command", "leased-command"]) {
			await call(mailbox, "/reserve", envelope(id, id));
			await call(mailbox, "/commit", { commandId: id });
		}
		const cancelled = await call(mailbox, "/cancel", {
			commandId: "queued-command",
		});
		expect(cancelled.status).toBe(200);
		expect((await cancelled.json()).state).toBe("cancelled");
		await call(mailbox, "/lease", {
			runtimeGeneration: 1,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
		});
		const tooLate = await call(mailbox, "/cancel", {
			commandId: "leased-command",
		});
		expect(tooLate.status).toBe(409);
		expect((await tooLate.json()).code).toBe("command-already-leased");
	});

	test("never replays ever-leased work after storage replacement", async () => {
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("command-1"));
		await call(mailbox, "/commit", { commandId: "command-1" });
		await call(mailbox, "/lease", {
			runtimeGeneration: 1,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
		});
		const replacement = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-2",
			})
		).json();
		expect(replacement.leases).toEqual([]);
		const status = await (
			await call(mailbox, "/status?commandId=command-1")
		).json();
		expect(status.state).toBe("outcome-unknown");
	});

	test("re-leases after a newer runtime generation fences the old consumer", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("command-1"));
		await call(mailbox, "/commit", { commandId: "command-1" });
		const oldLease = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
			})
		).json();
		vi.advanceTimersByTime(31_000);
		await mailbox.alarm();
		const sameGeneration = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
			})
		).json();
		expect(sameGeneration.leases).toEqual([]);
		const replacement = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-1",
			})
		).json();
		expect(replacement.leases[0].command.commandId).toBe("command-1");
		const staleAck = await call(mailbox, "/ack", {
			commandId: "command-1",
			leaseToken: oldLease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:command-1",
			state: "applied",
		});
		expect(staleAck.status).toBe(409);
	});

	test("destructive lifecycle fences queued and leased commands", async () => {
		const mailbox = makeMailbox();
		for (const id of ["leased-command", "queued-command"]) {
			await call(mailbox, "/reserve", envelope(id, "same-session"));
			await call(mailbox, "/commit", { commandId: id });
		}
		await call(mailbox, "/lease", {
			runtimeGeneration: 1,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
		});
		await call(mailbox, "/lifecycle", { action: "delete" });
		const leased = await (
			await call(mailbox, "/status?commandId=leased-command")
		).json();
		const queued = await (
			await call(mailbox, "/status?commandId=queued-command")
		).json();
		expect(leased.state).toBe("outcome-unknown");
		expect(queued.state).toBe("cancelled");
	});
});
