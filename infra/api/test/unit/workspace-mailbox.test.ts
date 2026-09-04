import { DatabaseSync } from "node:sqlite";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
	AgentSessionId,
	CLOUD_COMMAND_LEASE_TTL_MS,
	CloudCommandEnvelope,
	CommandId,
} from "@zuse/contracts";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceMailbox } from "../../src/workspace-mailbox.ts";

const makeMailboxHarness = () => {
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
			deleteAlarm: async () => {
				alarm = null;
			},
		},
	} as unknown as DurableObjectState;
	const mailbox = new WorkspaceMailbox(state);
	return {
		mailbox,
		alarm: () => alarm,
		fireAlarm: async () => {
			alarm = null;
			await mailbox.alarm();
		},
		rows: <Row>(query: string, ...bindings: Array<string | number>) =>
			database.prepare(query).all(...bindings) as Row[],
		run: (query: string, ...bindings: Array<string | number>) =>
			database.prepare(query).run(...bindings),
	};
};

const makeMailbox = () => makeMailboxHarness().mailbox;

const envelope = (
	commandId: string,
	sessionId = "session-1",
	destructionFence = 0,
) =>
	CloudCommandEnvelope.make({
		protocolVersion: 3,
		workspaceId: "workspace-1",
		sessionId: AgentSessionId.make(sessionId),
		commandId: CommandId.make(commandId),
		kind: "messages.send",
		fingerprint: `hmac-sha256:${commandId}`,
		schemaVersion: 1,
		keyVersion: 1,
		destructionFence,
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
		const duplicate = await call(mailbox, "/reserve", command);
		expect(duplicate.status).toBe(200);
		expect(await duplicate.json()).toMatchObject({
			existing: true,
			status: { fingerprint: command.fingerprint },
		});
		expect(
			(
				await call(mailbox, "/reserve", {
					...command,
					fingerprint: "hmac-sha256:different",
				})
			).status,
		).toBe(409);
		expect(
			(
				await call(mailbox, "/reserve", {
					...command,
					sessionId: AgentSessionId.make("different-session"),
				})
			).status,
		).toBe(409);
		expect(
			(
				await call(mailbox, "/reserve", {
					...command,
					destructionFence: command.destructionFence + 1,
				})
			).status,
		).toBe(409);
	});

	test("enforces the shared kind, schema, and dependency registry before reserving capacity", async () => {
		const mailbox = makeMailbox();
		const command = envelope("command-policy");
		for (const invalid of [
			{ ...command, kind: "git.status" },
			{ ...command, schemaVersion: 2 },
			{
				...command,
				dependencies: [
					{
						blobId: "blob-1",
						ciphertextBytes: 1,
						ciphertextSha256: "sha256",
						keyVersion: 1,
						expiresAt: Date.now() + 60_000,
					},
				],
			},
		]) {
			const response = await call(mailbox, "/reserve", invalid);
			expect(response.status).toBe(400);
			expect(await response.json()).toEqual({
				code: "cloud-command-not-eligible",
			});
		}
		expect(
			(await call(mailbox, "/status?commandId=command-policy")).status,
		).toBe(404);
	});

	test("durably blocks accepted commands and resumes matching policy holds", async () => {
		const mailbox = makeMailbox();
		for (const id of ["billing-command", "auth-command"]) {
			await call(mailbox, "/reserve", envelope(id, id));
		}
		const accepted = await call(mailbox, "/commit", {
			commandId: "billing-command",
			blockedUntil: "billing-restored",
		});
		expect(accepted.status).toBe(202);
		expect(await accepted.json()).toMatchObject({
			state: "blocked",
		});
		await call(mailbox, "/commit", {
			commandId: "auth-command",
			blockedUntil: "auth-restored",
		});

		const whileBlocked = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		expect(whileBlocked.leases).toEqual([]);

		const unblocked = await call(mailbox, "/unblock", {
			blockedUntil: "billing-restored",
		});
		expect(await unblocked.json()).toEqual({ unblocked: 1 });
		expect(
			await (await call(mailbox, "/status?commandId=billing-command")).json(),
		).toMatchObject({ state: "waiting-for-runtime" });
		expect(
			await (await call(mailbox, "/status?commandId=auth-command")).json(),
		).toMatchObject({ state: "blocked", blockedUntil: "auth-restored" });
	});

	test("bulk policy changes never block already leased work", async () => {
		const mailbox = makeMailbox();
		for (const id of ["leased-command", "queued-command"]) {
			await call(mailbox, "/reserve", envelope(id, "same-session"));
			await call(mailbox, "/commit", { commandId: id });
		}
		await call(mailbox, "/lease", {
			runtimeGeneration: 1,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
			destructionFence: 0,
		});
		const blocked = await call(mailbox, "/block", {
			blockedUntil: "billing-restored",
		});
		expect(await blocked.json()).toEqual({ blocked: 1 });
		expect(
			await (await call(mailbox, "/status?commandId=leased-command")).json(),
		).toMatchObject({ state: "leased" });
		expect(
			await (await call(mailbox, "/status?commandId=queued-command")).json(),
		).toMatchObject({ state: "blocked", blockedUntil: "billing-restored" });
	});

	test("global policy blocks do not accept an uncommitted reservation", async () => {
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("reserved-command"));

		const blocked = await call(mailbox, "/block", {
			blockedUntil: "billing-restored",
		});
		const status = await (
			await call(mailbox, "/status?commandId=reserved-command")
		).json();

		expect(await blocked.json()).toEqual({ blocked: 0 });
		expect(status).toMatchObject({ state: "reserved" });
		expect(status).not.toHaveProperty("acceptedAt");
		expect(status).not.toHaveProperty("blockedUntil");

		const committed = await call(mailbox, "/commit", {
			commandId: "reserved-command",
			blockedUntil: "billing-restored",
		});
		expect(committed.status).toBe(202);
		expect(await committed.json()).toMatchObject({
			state: "blocked",
			acceptedAt: expect.any(Number),
		});
	});

	test("commit rejects a reservation that expired before acceptance", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		const harness = makeMailboxHarness();
		await call(harness.mailbox, "/reserve", envelope("expired-reservation"));
		vi.advanceTimersByTime(60_000);
		await harness.fireAlarm();

		const committed = await call(harness.mailbox, "/commit", {
			commandId: "expired-reservation",
		});

		expect(committed.status).toBe(409);
		expect(await committed.json()).toMatchObject({
			code: "command-not-accepted",
			status: {
				state: "cancelled",
				category: "reservation-expired",
			},
		});
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
				destructionFence: 0,
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

	test("paginates all 256 changed commands without skipping after page 100", async () => {
		const mailbox = makeMailbox();
		const commandIds = Array.from(
			{ length: 256 },
			(_, index) => `command-${String(index).padStart(3, "0")}`,
		);
		for (const commandId of commandIds)
			await call(mailbox, "/reserve", envelope(commandId));
		expect(
			(await call(mailbox, "/reserve", envelope("command-over-capacity")))
				.status,
		).toBe(429);

		const first = await (await call(mailbox, "/watch?afterRevision=0")).json();
		const second = await (
			await call(mailbox, `/watch?afterRevision=${first.nextRevision}`)
		).json();
		const third = await (
			await call(mailbox, `/watch?afterRevision=${second.nextRevision}`)
		).json();
		expect(first.changes).toHaveLength(100);
		expect(first.nextRevision).toBe(100);
		expect(second.changes).toHaveLength(100);
		expect(second.nextRevision).toBe(200);
		expect(third.changes).toHaveLength(56);
		expect(third.nextRevision).toBe(256);
		expect(
			[...first.changes, ...second.changes, ...third.changes].map(
				(status) => status.commandId,
			),
		).toEqual(commandIds);
	});

	test("coalesces repeated command revisions without skipping later commands", async () => {
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("command-1"));
		await call(mailbox, "/commit", { commandId: "command-1" });
		await call(mailbox, "/reserve", envelope("command-2"));
		const page = await (await call(mailbox, "/watch?afterRevision=0")).json();
		expect(
			page.changes.map((status: { commandId: string; revision: number }) => [
				status.commandId,
				status.revision,
			]),
		).toEqual([
			["command-1", 2],
			["command-2", 3],
		]);
		expect(page.nextRevision).toBe(3);
	});

	test("reset-required preserves targeted status recovery for old pending IDs", async () => {
		const harness = makeMailboxHarness();
		await call(harness.mailbox, "/reserve", envelope("pending-command"));
		harness.run("DELETE FROM mailbox_changes");
		harness.run(
			"INSERT INTO mailbox_changes(revision, command_id) VALUES (20, 'newer-command')",
		);
		harness.run("UPDATE mailbox_meta SET value = '20' WHERE key = 'revision'");

		const reset = await (
			await call(harness.mailbox, "/watch?afterRevision=0")
		).json();
		expect(reset).toEqual({
			changes: [],
			nextRevision: 20,
			resetRequired: true,
		});
		const recovered = await (
			await call(harness.mailbox, "/status?commandId=pending-command")
		).json();
		expect(recovered).toMatchObject({
			commandId: "pending-command",
			revision: 1,
			state: "reserved",
		});
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
				destructionFence: 0,
			})
		).json()) as {
			leases: Array<{
				command: { commandId: string };
				leaseToken: string;
				runtimeGeneration: number;
				providerSandboxId: string;
				storageIncarnationId: string;
			}>;
			nonterminalCount: number;
			mailboxRevision: number;
			fenceRequired: boolean;
		};
		expect(first.leases.map((lease) => lease.command.commandId)).toEqual([
			"command-1",
		]);
		expect(first.leases[0]).toMatchObject({
			runtimeGeneration: 1,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
		});
		expect(first.nonterminalCount).toBe(2);
		expect(first.mailboxRevision).toBeGreaterThan(4);
		expect(first.fenceRequired).toBe(false);
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
				destructionFence: 0,
			})
		).json();
		expect(second.leases[0].command.commandId).toBe("command-2");
		expect(second.nonterminalCount).toBe(1);
		expect(second.mailboxRevision).toBeGreaterThan(first.mailboxRevision);
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
			destructionFence: 0,
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
			destructionFence: 0,
		});
		const replacement = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-2",
				destructionFence: 0,
			})
		).json();
		expect(replacement.leases).toEqual([]);
		const status = await (
			await call(mailbox, "/status?commandId=command-1")
		).json();
		expect(status.state).toBe("outcome-unknown");
	});

	test("accepts the original receipt after lease expiry until it is fenced", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		const harness = makeMailboxHarness();
		await call(harness.mailbox, "/reserve", envelope("command-1"));
		await call(harness.mailbox, "/commit", { commandId: "command-1" });
		const lease = await (
			await call(harness.mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		vi.advanceTimersByTime(31_000);
		await harness.fireAlarm();
		expect(
			await (await call(harness.mailbox, "/status?commandId=command-1")).json(),
		).toMatchObject({ state: "lease-expired-awaiting-fence" });

		const acknowledgment = await call(harness.mailbox, "/ack", {
			commandId: "command-1",
			leaseToken: lease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:command-1",
			state: "applied",
		});
		expect(acknowledgment.status).toBe(200);
		expect(await acknowledgment.json()).toMatchObject({ state: "applied" });
		const collidedReplay = await call(harness.mailbox, "/ack", {
			commandId: "command-1",
			leaseToken: lease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:different-command",
			state: "applied",
		});
		expect(collidedReplay.status).toBe(409);
		expect(await collidedReplay.json()).toEqual({
			code: "command-fingerprint-mismatch",
		});
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
				destructionFence: 0,
			})
		).json();
		await call(mailbox, "/reserve", envelope("command-2", "session-2"));
		await call(mailbox, "/commit", { commandId: "command-2" });
		vi.advanceTimersByTime(31_000);
		const sameGeneration = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		expect(sameGeneration.leases).toEqual([]);
		expect(sameGeneration.fenceRequired).toBe(true);
		expect(sameGeneration.nonterminalCount).toBe(2);
		const replacement = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		expect(
			replacement.leases.map(
				(lease: { command: { commandId: string } }) => lease.command.commandId,
			),
		).toEqual(["command-1", "command-2"]);
		expect(replacement.fenceRequired).toBe(false);
		const staleAck = await call(mailbox, "/ack", {
			commandId: "command-1",
			leaseToken: oldLease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:command-1",
			state: "applied",
		});
		expect(staleAck.status).toBe(200);
		expect(await staleAck.json()).toMatchObject({
			acknowledged: false,
			code: "stale-runtime-lease",
			status: { state: "leased" },
		});
	});

	test("never lets a delayed older generation reclaim mailbox authority", async () => {
		const mailbox = makeMailbox();
		const current = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-2",
				destructionFence: 0,
			})
		).json();
		expect(current.leases).toEqual([]);

		await call(mailbox, "/reserve", envelope("command-1"));
		await call(mailbox, "/commit", { commandId: "command-1" });
		const delayed = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		expect(delayed).toMatchObject({ leases: [], fenced: true });

		const authoritative = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-2",
				destructionFence: 0,
			})
		).json();
		expect(authoritative.leases[0].command.commandId).toBe("command-1");
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
			destructionFence: 0,
		});
		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});
		const leased = await (
			await call(mailbox, "/status?commandId=leased-command")
		).json();
		const queued = await (
			await call(mailbox, "/status?commandId=queued-command")
		).json();
		expect(leased).toMatchObject({
			state: "leased",
			category: "workspace-archived-after-lease",
		});
		expect(queued.state).toBe("cancelled");
	});

	test("accepts the original runtime receipt after a destructive lifecycle fence", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("leased-command"));
		await call(mailbox, "/commit", { commandId: "leased-command" });
		const lease = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();

		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});
		const staleAcknowledgment = await call(mailbox, "/ack", {
			commandId: "leased-command",
			leaseToken: "not-the-original-lease",
			fingerprint: "hmac-sha256:leased-command",
			state: "applied",
		});
		expect(await staleAcknowledgment.json()).toMatchObject({
			acknowledged: false,
			code: "stale-runtime-lease",
			status: { state: "leased" },
		});
		vi.advanceTimersByTime(CLOUD_COMMAND_LEASE_TTL_MS - 1);
		const acknowledgment = await call(mailbox, "/ack", {
			commandId: "leased-command",
			leaseToken: lease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:leased-command",
			state: "applied",
		});

		expect(acknowledgment.status).toBe(200);
		expect(await acknowledgment.json()).toMatchObject({
			state: "applied",
		});
	});

	test("alarm terminalizes lifecycle-fenced work without a replacement runtime", async () => {
		vi.useFakeTimers();
		const startedAt = new Date("2026-09-03T00:00:00Z").getTime();
		vi.setSystemTime(startedAt);
		const harness = makeMailboxHarness();
		const { mailbox } = harness;
		await call(mailbox, "/reserve", envelope("old-command", "same-session"));
		await call(mailbox, "/commit", { commandId: "old-command" });
		const originalLease = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});
		await call(mailbox, "/reserve", envelope("new-command", "same-session", 1));
		await call(mailbox, "/commit", { commandId: "new-command" });
		expect(harness.alarm()).toBe(startedAt + CLOUD_COMMAND_LEASE_TTL_MS);

		vi.advanceTimersByTime(CLOUD_COMMAND_LEASE_TTL_MS);
		await harness.fireAlarm();
		expect(
			await (await call(mailbox, "/status?commandId=old-command")).json(),
		).toMatchObject({
			state: "outcome-unknown",
			category: "workspace-archived-after-lease",
		});
		const lateReceipt = await call(mailbox, "/ack", {
			commandId: "old-command",
			leaseToken: originalLease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:old-command",
			state: "applied",
		});
		expect(await lateReceipt.json()).toMatchObject({
			state: "outcome-unknown",
			category: "workspace-archived-after-lease",
		});

		const replacement = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-1",
				destructionFence: 1,
			})
		).json();

		expect(
			replacement.leases.map(
				(lease: { command: { commandId: string } }) => lease.command.commandId,
			),
		).toEqual(["new-command"]);
	});

	test("an acknowledgment cannot outrun lifecycle terminalization at the deadline", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("leased-command"));
		await call(mailbox, "/commit", { commandId: "leased-command" });
		const lease = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});
		vi.advanceTimersByTime(CLOUD_COMMAND_LEASE_TTL_MS);

		const acknowledgment = await call(mailbox, "/ack", {
			commandId: "leased-command",
			leaseToken: lease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:leased-command",
			state: "applied",
		});

		expect(await acknowledgment.json()).toMatchObject({
			state: "outcome-unknown",
			category: "workspace-archived-after-lease",
		});
	});

	test("destruction terminalizes a lease whose original deadline already expired", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
		const harness = makeMailboxHarness();
		await call(harness.mailbox, "/reserve", envelope("expired-command"));
		await call(harness.mailbox, "/commit", {
			commandId: "expired-command",
		});
		await call(harness.mailbox, "/lease", {
			runtimeGeneration: 1,
			providerSandboxId: "sandbox-1",
			storageIncarnationId: "storage-1",
			destructionFence: 0,
		});
		vi.advanceTimersByTime(CLOUD_COMMAND_LEASE_TTL_MS);
		await harness.fireAlarm();
		expect(
			await (
				await call(harness.mailbox, "/status?commandId=expired-command")
			).json(),
		).toMatchObject({ state: "lease-expired-awaiting-fence" });

		await call(harness.mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});

		expect(
			await (
				await call(harness.mailbox, "/status?commandId=expired-command")
			).json(),
		).toMatchObject({
			state: "outcome-unknown",
			category: "workspace-archived-after-lease",
		});
	});

	test("storage replacement closes lifecycle receipt grace without replay", async () => {
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("leased-command"));
		await call(mailbox, "/commit", { commandId: "leased-command" });
		const originalLease = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});

		const replacement = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-2",
				destructionFence: 1,
			})
		).json();
		expect(replacement.leases).toEqual([]);
		const lateReceipt = await call(mailbox, "/ack", {
			commandId: "leased-command",
			leaseToken: originalLease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:leased-command",
			state: "applied",
		});
		expect(await lateReceipt.json()).toMatchObject({
			state: "outcome-unknown",
			category: "runtime-storage-replaced",
		});
	});

	test("lifecycle fences are idempotent and missed hooks cannot replay stale work", async () => {
		const mailbox = makeMailbox();
		await call(mailbox, "/reserve", envelope("old-command"));
		await call(mailbox, "/commit", { commandId: "old-command" });

		const afterMissedHook = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-1",
				destructionFence: 1,
			})
		).json();
		expect(afterMissedHook.leases).toEqual([]);
		expect(
			await (await call(mailbox, "/status?commandId=old-command")).json(),
		).toMatchObject({ state: "cancelled" });
		expect(
			(await call(mailbox, "/reserve", envelope("stale-command"))).status,
		).toBe(409);

		await call(mailbox, "/reserve", envelope("new-command", "session-1", 1));
		await call(mailbox, "/commit", { commandId: "new-command" });
		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});
		// A delayed duplicate lifecycle delivery must not cancel commands accepted
		// after the workspace was unarchived at the same authoritative fence.
		await call(mailbox, "/lifecycle", {
			action: "archive",
			destructionFence: 1,
		});
		expect(
			await (await call(mailbox, "/status?commandId=new-command")).json(),
		).toMatchObject({ state: "accepted" });

		const staleRuntime = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		expect(staleRuntime).toMatchObject({ leases: [], fenced: true });
		const currentRuntime = await (
			await call(mailbox, "/lease", {
				runtimeGeneration: 2,
				providerSandboxId: "sandbox-2",
				storageIncarnationId: "storage-1",
				destructionFence: 1,
			})
		).json();
		expect(currentRuntime.leases[0].command.commandId).toBe("new-command");
	});

	test("schedules and applies terminal envelope and result retention", async () => {
		vi.useFakeTimers();
		const startedAt = new Date("2026-09-03T00:00:00Z").getTime();
		vi.setSystemTime(startedAt);
		const harness = makeMailboxHarness();
		const command = envelope("command-1");
		await call(harness.mailbox, "/reserve", command);
		await call(harness.mailbox, "/commit", { commandId: "command-1" });
		const lease = await (
			await call(harness.mailbox, "/lease", {
				runtimeGeneration: 1,
				providerSandboxId: "sandbox-1",
				storageIncarnationId: "storage-1",
				destructionFence: 0,
			})
		).json();
		await call(harness.mailbox, "/ack", {
			commandId: "command-1",
			leaseToken: lease.leases[0].leaseToken,
			fingerprint: "hmac-sha256:command-1",
			state: "applied",
			resultIv: "result-iv",
			resultCiphertext: "result-ciphertext",
		});

		// The earlier lease alarm may remain, but once it fires the terminal
		// retention deadline must be scheduled explicitly.
		vi.advanceTimersByTime(31_000);
		await harness.fireAlarm();
		const retentionMs = 30 * 24 * 60 * 60_000;
		expect(harness.alarm()).toBe(startedAt + retentionMs);

		vi.setSystemTime(startedAt + retentionMs + 1);
		await harness.fireAlarm();
		const [stored] = harness.rows<{
			envelope_json: string;
			envelope_bytes: number;
			result_iv: string | null;
			result_ciphertext: string | null;
		}>(
			`SELECT envelope_json, envelope_bytes, result_iv, result_ciphertext
			 FROM mailbox_commands WHERE command_id = 'command-1'`,
		);
		expect(stored).toEqual({
			envelope_json: "",
			envelope_bytes: 0,
			result_iv: null,
			result_ciphertext: null,
		});
		expect((await call(harness.mailbox, "/reserve", command)).status).toBe(200);
		expect(harness.alarm()).toBeNull();
	});
});
