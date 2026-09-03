import type { DurableObjectState } from "@cloudflare/workers-types";
import {
	CLOUD_COMMAND_MAX_ENVELOPE_BYTES,
	CLOUD_COMMAND_MAX_MAILBOX_BYTES,
	CLOUD_COMMAND_MAX_NONTERMINAL,
	CLOUD_COMMAND_WATCH_MAX_CHANGES,
	CLOUD_COMMAND_WATCH_MAX_WAIT_MS,
	type CloudCommandEnvelope,
	type CloudCommandState,
	type RuntimeAcknowledgment,
} from "@zuse/contracts";

type SqlRow = Record<string, string | number | null>;

const TERMINAL = new Set<CloudCommandState>([
	"applied",
	"rejected",
	"expired",
	"cancelled",
	"outcome-unknown",
]);
const RESERVATION_TTL_MS = 60_000;
const LEASE_TTL_MS = 30_000;
const RESULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CHANGE_HISTORY_LIMIT = 10_000;

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
	new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

const envelopeBytes = (envelope: CloudCommandEnvelope): number =>
	new TextEncoder().encode(JSON.stringify(envelope)).byteLength;

/**
 * Stable, hibernatable command coordinator. Its object ID is the workspace ID,
 * never a gateway epoch. Payload and result bytes remain client encrypted.
 */
export class WorkspaceMailbox {
	private readonly sql;
	private readonly waiters = new Set<() => void>();

	constructor(private readonly state: DurableObjectState) {
		this.sql = state.storage.sql;
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mailbox_meta (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mailbox_commands (
			command_id TEXT PRIMARY KEY,
			workspace_sequence INTEGER NOT NULL UNIQUE,
			lane TEXT NOT NULL,
			kind TEXT NOT NULL,
			fingerprint TEXT NOT NULL,
			schema_version INTEGER NOT NULL,
			envelope_json TEXT NOT NULL,
			envelope_bytes INTEGER NOT NULL,
			state TEXT NOT NULL,
			ever_leased INTEGER NOT NULL DEFAULT 0,
			lease_token TEXT,
			lease_deadline INTEGER,
			runtime_generation INTEGER,
			provider_sandbox_id TEXT,
			storage_incarnation_id TEXT,
			category TEXT,
			blocked_until TEXT,
			result_iv TEXT,
			result_ciphertext TEXT,
			created_at INTEGER NOT NULL,
			accepted_at INTEGER,
			updated_at INTEGER NOT NULL,
			terminal_at INTEGER
		)`);
		this.sql.exec(
			"CREATE INDEX IF NOT EXISTS mailbox_lane_order ON mailbox_commands(lane, workspace_sequence)",
		);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS mailbox_changes (
			revision INTEGER PRIMARY KEY,
			command_id TEXT NOT NULL
		)`);
	}

	private rows(query: string, ...bindings: Array<string | number>): SqlRow[] {
		return this.sql.exec<SqlRow>(query, ...bindings).toArray();
	}

	private next(name: "sequence" | "revision"): number {
		const row = this.rows(
			"SELECT value FROM mailbox_meta WHERE key = ?",
			name,
		)[0];
		const value = Number(row?.value ?? 0) + 1;
		this.sql.exec(
			"INSERT INTO mailbox_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			name,
			String(value),
		);
		return value;
	}

	private changed(commandId: string): number {
		const revision = this.next("revision");
		this.sql.exec(
			"INSERT INTO mailbox_changes(revision, command_id) VALUES (?, ?)",
			revision,
			commandId,
		);
		this.sql.exec(
			"DELETE FROM mailbox_changes WHERE revision <= ?",
			revision - CHANGE_HISTORY_LIMIT,
		);
		for (const wake of this.waiters) wake();
		this.waiters.clear();
		return revision;
	}

	private status(commandId: string): Record<string, unknown> | null {
		const row = this.rows(
			"SELECT * FROM mailbox_commands WHERE command_id = ?",
			commandId,
		)[0];
		if (row === undefined) return null;
		const change = this.rows(
			"SELECT MAX(revision) AS revision FROM mailbox_changes WHERE command_id = ?",
			commandId,
		)[0];
		return {
			commandId: row.command_id,
			workspaceSequence: row.workspace_sequence,
			revision: Number(change?.revision ?? 0),
			state: row.state,
			everLeased: row.ever_leased === 1,
			updatedAt: row.updated_at,
			...(row.accepted_at === null ? {} : { acceptedAt: row.accepted_at }),
			...(row.category === null ? {} : { category: row.category }),
			...(row.blocked_until === null
				? {}
				: { blockedUntil: row.blocked_until }),
			...(row.result_iv === null ? {} : { resultIv: row.result_iv }),
			...(row.result_ciphertext === null
				? {}
				: { resultCiphertext: row.result_ciphertext }),
		};
	}

	private reserveUnsafe(envelope: CloudCommandEnvelope): Response {
		const bytes = envelopeBytes(envelope);
		if (bytes > CLOUD_COMMAND_MAX_ENVELOPE_BYTES)
			return json({ code: "command-envelope-too-large" }, 413);
		const existing = this.rows(
			"SELECT fingerprint, kind, schema_version, state FROM mailbox_commands WHERE command_id = ?",
			envelope.commandId,
		)[0];
		if (existing !== undefined) {
			if (
				existing.fingerprint !== envelope.fingerprint ||
				existing.kind !== envelope.kind ||
				existing.schema_version !== envelope.schemaVersion
			)
				return json({ code: "command-identity-collision" }, 409);
			return json({
				reserved: true,
				existing: true,
				status: this.status(envelope.commandId),
			});
		}
		const usage =
			this.rows(`SELECT COUNT(*) AS count, COALESCE(SUM(envelope_bytes), 0) AS bytes
			FROM mailbox_commands WHERE state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`)[0];
		if (
			Number(usage?.count ?? 0) >= CLOUD_COMMAND_MAX_NONTERMINAL ||
			Number(usage?.bytes ?? 0) + bytes > CLOUD_COMMAND_MAX_MAILBOX_BYTES
		)
			return json({ code: "mailbox-capacity" }, 429, { "retry-after": "30" });
		const now = Date.now();
		const sequence = this.next("sequence");
		this.sql.exec(
			`INSERT INTO mailbox_commands(command_id, workspace_sequence, lane, kind, fingerprint,
			 schema_version, envelope_json, envelope_bytes, state, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)`,
			envelope.commandId,
			sequence,
			`session:${envelope.sessionId}`,
			envelope.kind,
			envelope.fingerprint,
			envelope.schemaVersion,
			JSON.stringify(envelope),
			bytes,
			now,
			now,
		);
		this.changed(envelope.commandId);
		return json({
			reserved: true,
			existing: false,
			workspaceSequence: sequence,
		});
	}

	private async reserve(envelope: CloudCommandEnvelope): Promise<Response> {
		const response = this.state.storage.transactionSync(() =>
			this.reserveUnsafe(envelope),
		);
		if (response.ok) await this.schedule(Date.now() + RESERVATION_TTL_MS);
		return response;
	}

	private commitUnsafe(commandId: string): Response {
		const now = Date.now();
		const before = this.rows(
			"SELECT state, accepted_at FROM mailbox_commands WHERE command_id = ?",
			commandId,
		)[0];
		if (before === undefined) return json({ code: "command-not-found" }, 404);
		this.sql.exec(
			"UPDATE mailbox_commands SET state = 'accepted', accepted_at = ?, updated_at = ? WHERE command_id = ? AND state = 'reserved'",
			now,
			now,
			commandId,
		);
		if (before.state === "reserved") this.changed(commandId);
		const current = this.status(commandId) as Record<string, unknown>;
		const acceptanceState =
			current.state === "waiting-for-runtime" || current.state === "blocked"
				? current.state
				: "accepted";
		return json(
			{
				commandId,
				workspaceSequence: current.workspaceSequence,
				revision: current.revision,
				acceptedAt: current.acceptedAt ?? before.accepted_at ?? now,
				// Enqueue acknowledges durable acceptance even when this is a retry
				// after the command already reached a terminal state. The client checks
				// status before watching, so no terminal revision can be missed.
				state: acceptanceState,
			},
			202,
		);
	}

	private commit(commandId: string): Response {
		const response = this.state.storage.transactionSync(() =>
			this.commitUnsafe(commandId),
		);
		const status = this.status(commandId);
		console.info("[workspace-mailbox] command accepted", {
			commandId,
			workspaceSequence: status?.workspaceSequence,
			revision: status?.revision,
		});
		return response;
	}

	private cancelUnsafe(
		commandId: string,
		category = "cancelled-by-user",
	): Response {
		const now = Date.now();
		const before = this.status(commandId);
		if (before === null) return json({ code: "command-not-found" }, 404);
		this.sql.exec(
			`UPDATE mailbox_commands SET state = 'cancelled', category = ?, updated_at = ?, terminal_at = ?
			 WHERE command_id = ? AND ever_leased = 0 AND state IN ('reserved','accepted','waiting-for-runtime','blocked')`,
			category,
			now,
			now,
			commandId,
		);
		const status = this.status(commandId) as Record<string, unknown>;
		if (before.state !== "cancelled" && status.state === "cancelled")
			this.changed(commandId);
		return TERMINAL.has(status.state as CloudCommandState)
			? json(this.status(commandId))
			: json({ code: "command-already-leased", status }, 409);
	}

	private cancel(commandId: string, category = "cancelled-by-user"): Response {
		return this.state.storage.transactionSync(() =>
			this.cancelUnsafe(commandId, category),
		);
	}

	private leaseUnsafe(input: {
		runtimeGeneration: number;
		providerSandboxId: string;
		storageIncarnationId: string;
	}): Response {
		const now = Date.now();
		const previousIncarnation = this.rows(
			"SELECT value FROM mailbox_meta WHERE key = 'storage-incarnation'",
		)[0]?.value;
		if (
			previousIncarnation !== undefined &&
			previousIncarnation !== null &&
			previousIncarnation !== input.storageIncarnationId
		) {
			const affected = this.rows(
				`SELECT command_id FROM mailbox_commands WHERE ever_leased = 1
				 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
			);
			this.sql.exec(
				`UPDATE mailbox_commands SET state = 'outcome-unknown', category = 'runtime-storage-replaced',
				 updated_at = ?, terminal_at = ? WHERE ever_leased = 1
				 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
				now,
				now,
			);
			for (const row of affected) this.changed(String(row.command_id));
		}
		this.sql.exec(
			"INSERT INTO mailbox_meta(key,value) VALUES ('storage-incarnation', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			input.storageIncarnationId,
		);
		// A newer control-plane runtime generation fences every credential from
		// the prior generation. With the same SQLite incarnation it is therefore
		// safe to re-lease: the runtime receipt prevents a duplicate apply.
		const fenced = this.rows(
			`SELECT command_id FROM mailbox_commands
			 WHERE state = 'lease-expired-awaiting-fence' AND storage_incarnation_id = ?
			 AND runtime_generation < ?`,
			input.storageIncarnationId,
			input.runtimeGeneration,
		);
		this.sql.exec(
			`UPDATE mailbox_commands SET state = 'waiting-for-runtime', category = 'runtime-generation-fenced',
			 lease_token = NULL, lease_deadline = NULL, updated_at = ?
			 WHERE state = 'lease-expired-awaiting-fence' AND storage_incarnation_id = ?
			 AND runtime_generation < ?`,
			now,
			input.storageIncarnationId,
			input.runtimeGeneration,
		);
		for (const row of fenced) this.changed(String(row.command_id));
		const candidates = this.rows(`SELECT command_id FROM mailbox_commands c
			WHERE c.state IN ('accepted','waiting-for-runtime')
			AND NOT EXISTS (
				SELECT 1 FROM mailbox_commands prior WHERE prior.lane = c.lane
				AND prior.workspace_sequence < c.workspace_sequence
				AND prior.state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')
			)
			ORDER BY workspace_sequence LIMIT 16`);
		const leases: Array<Record<string, unknown>> = [];
		for (const candidate of candidates) {
			const commandId = String(candidate.command_id);
			const token = crypto.randomUUID();
			const deadline = now + LEASE_TTL_MS;
			this.sql.exec(
				`UPDATE mailbox_commands SET state = 'leased', ever_leased = 1, lease_token = ?,
				 lease_deadline = ?, runtime_generation = ?, provider_sandbox_id = ?, storage_incarnation_id = ?, updated_at = ?
				 WHERE command_id = ? AND state IN ('accepted','waiting-for-runtime')`,
				token,
				deadline,
				input.runtimeGeneration,
				input.providerSandboxId,
				input.storageIncarnationId,
				now,
				commandId,
			);
			const row = this.rows(
				"SELECT envelope_json, workspace_sequence FROM mailbox_commands WHERE command_id = ? AND lease_token = ?",
				commandId,
				token,
			)[0];
			if (row === undefined) continue;
			this.changed(commandId);
			leases.push({
				command: JSON.parse(String(row.envelope_json)),
				workspaceSequence: row.workspace_sequence,
				leaseToken: token,
				leaseDeadline: deadline,
				runtimeGeneration: input.runtimeGeneration,
				storageIncarnationId: input.storageIncarnationId,
			});
		}
		if (leases.length > 0)
			console.info("[workspace-mailbox] commands leased", {
				runtimeGeneration: input.runtimeGeneration,
				storageIncarnationId: input.storageIncarnationId,
				count: leases.length,
			});
		return json({ leases });
	}

	private lease(input: {
		runtimeGeneration: number;
		providerSandboxId: string;
		storageIncarnationId: string;
	}): Response {
		const response = this.state.storage.transactionSync(() =>
			this.leaseUnsafe(input),
		);
		void this.schedule(Date.now() + LEASE_TTL_MS);
		return response;
	}

	private acknowledgeUnsafe(ack: RuntimeAcknowledgment): Response {
		if (
			(ack.resultIv?.length ?? 0) + (ack.resultCiphertext?.length ?? 0) >
			CLOUD_COMMAND_MAX_ENVELOPE_BYTES
		)
			return json({ code: "command-result-too-large" }, 413);
		const row = this.rows(
			"SELECT fingerprint, state, lease_token FROM mailbox_commands WHERE command_id = ?",
			ack.commandId,
		)[0];
		if (row === undefined) return json({ code: "command-not-found" }, 404);
		if (TERMINAL.has(row.state as CloudCommandState))
			return json(this.status(ack.commandId));
		if (row.fingerprint !== ack.fingerprint)
			return json({ code: "command-fingerprint-mismatch" }, 409);
		if (row.state !== "leased" || row.lease_token !== ack.leaseToken)
			return json({ code: "stale-runtime-lease" }, 409);
		const now = Date.now();
		this.sql.exec(
			`UPDATE mailbox_commands SET state = ?, category = ?, result_iv = ?, result_ciphertext = ?,
			 updated_at = ?, terminal_at = ?, lease_token = NULL, lease_deadline = NULL WHERE command_id = ?`,
			ack.state,
			ack.category ?? null,
			ack.resultIv ?? null,
			ack.resultCiphertext ?? null,
			now,
			now,
			ack.commandId,
		);
		this.changed(ack.commandId);
		return json(this.status(ack.commandId));
	}

	private acknowledge(ack: RuntimeAcknowledgment): Response {
		const response = this.state.storage.transactionSync(() =>
			this.acknowledgeUnsafe(ack),
		);
		console.info("[workspace-mailbox] command terminal", {
			commandId: ack.commandId,
			state: ack.state,
			category: ack.category,
		});
		return response;
	}

	private lifecycle(action: "archive" | "delete"): Response {
		return this.state.storage.transactionSync(() => {
			const now = Date.now();
			const neverLeased = this.rows(
				`SELECT command_id FROM mailbox_commands WHERE ever_leased = 0
				 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
			);
			this.sql.exec(
				`UPDATE mailbox_commands SET state = 'cancelled', category = ?, updated_at = ?, terminal_at = ?
				 WHERE ever_leased = 0 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
				`workspace-${action}d`,
				now,
				now,
			);
			for (const row of neverLeased) this.changed(String(row.command_id));
			if (action === "delete") {
				const leased = this.rows(
					`SELECT command_id FROM mailbox_commands WHERE ever_leased = 1
					 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
				);
				this.sql.exec(
					`UPDATE mailbox_commands SET state = 'outcome-unknown', category = 'workspace-deleted-after-lease',
					 updated_at = ?, terminal_at = ? WHERE ever_leased = 1
					 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
					now,
					now,
				);
				for (const row of leased) this.changed(String(row.command_id));
			}
			return json({ ok: true });
		});
	}

	private async watch(afterRevision: number): Promise<Response> {
		const read = () => {
			const oldest = Number(
				this.rows("SELECT MIN(revision) AS revision FROM mailbox_changes")[0]
					?.revision ?? 0,
			);
			const current = Number(
				this.rows("SELECT value FROM mailbox_meta WHERE key = 'revision'")[0]
					?.value ?? 0,
			);
			const resetRequired = oldest > 0 && afterRevision < oldest - 1;
			const ids = resetRequired
				? this.rows(
						"SELECT command_id FROM mailbox_commands ORDER BY workspace_sequence DESC LIMIT ?",
						CLOUD_COMMAND_WATCH_MAX_CHANGES,
					)
				: this.rows(
						"SELECT DISTINCT command_id, MAX(revision) AS revision FROM mailbox_changes WHERE revision > ? GROUP BY command_id ORDER BY revision LIMIT ?",
						afterRevision,
						CLOUD_COMMAND_WATCH_MAX_CHANGES,
					);
			return {
				changes: ids
					.map((row) => this.status(String(row.command_id)))
					.filter(Boolean),
				nextRevision: current,
				resetRequired,
			};
		};
		let page = read();
		if (page.changes.length === 0 && page.nextRevision <= afterRevision) {
			await new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					this.waiters.delete(wake);
					resolve();
				}, CLOUD_COMMAND_WATCH_MAX_WAIT_MS);
				const wake = () => {
					clearTimeout(timer);
					resolve();
				};
				this.waiters.add(wake);
			});
			page = read();
		}
		return json(page);
	}

	private async schedule(at: number): Promise<void> {
		const current = await this.state.storage.getAlarm();
		if (current === null || at < current) await this.state.storage.setAlarm(at);
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		const pendingDeadline = this.state.storage.transactionSync(() => {
			const expiredReservations = this.rows(
				"SELECT command_id FROM mailbox_commands WHERE state = 'reserved' AND updated_at <= ?",
				now - RESERVATION_TTL_MS,
			);
			this.sql.exec(
				"UPDATE mailbox_commands SET state = 'cancelled', category = 'reservation-expired', updated_at = ?, terminal_at = ? WHERE state = 'reserved' AND updated_at <= ?",
				now,
				now,
				now - RESERVATION_TTL_MS,
			);
			for (const row of expiredReservations)
				this.changed(String(row.command_id));
			const expiredLeases = this.rows(
				"SELECT command_id FROM mailbox_commands WHERE state = 'leased' AND lease_deadline <= ?",
				now,
			);
			this.sql.exec(
				"UPDATE mailbox_commands SET state = 'lease-expired-awaiting-fence', category = 'runtime-fence-required', updated_at = ? WHERE state = 'leased' AND lease_deadline <= ?",
				now,
				now,
			);
			for (const row of expiredLeases) this.changed(String(row.command_id));
			this.sql.exec(
				`UPDATE mailbox_commands SET result_iv = NULL, result_ciphertext = NULL,
				 envelope_json = '', envelope_bytes = 0,
				 category = CASE WHEN category IS NULL THEN 'result-expired' ELSE category END
				 WHERE terminal_at IS NOT NULL AND terminal_at <= ?`,
				now - RESULT_RETENTION_MS,
			);
			return this.rows(
				`SELECT MIN(deadline) AS deadline FROM (
			SELECT updated_at + ? AS deadline FROM mailbox_commands WHERE state = 'reserved'
			UNION ALL SELECT lease_deadline AS deadline FROM mailbox_commands WHERE state = 'leased'
		)`,
				RESERVATION_TTL_MS,
			)[0]?.deadline;
		});
		if (pendingDeadline !== null && pendingDeadline !== undefined)
			await this.schedule(Math.max(now + 1_000, Number(pendingDeadline)));
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/reserve")
				return this.reserve((await request.json()) as CloudCommandEnvelope);
			if (request.method === "POST" && url.pathname === "/commit") {
				const body = (await request.json()) as { commandId: string };
				return this.commit(body.commandId);
			}
			if (request.method === "POST" && url.pathname === "/cancel") {
				const body = (await request.json()) as {
					commandId: string;
					category?: string;
				};
				return this.cancel(body.commandId, body.category);
			}
			if (request.method === "POST" && url.pathname === "/lease")
				return this.lease((await request.json()) as never);
			if (request.method === "POST" && url.pathname === "/ack")
				return this.acknowledge(
					(await request.json()) as RuntimeAcknowledgment,
				);
			if (request.method === "POST" && url.pathname === "/lifecycle") {
				const body = (await request.json()) as { action: "archive" | "delete" };
				if (body.action !== "archive" && body.action !== "delete")
					return json({ code: "invalid-lifecycle-action" }, 400);
				return this.lifecycle(body.action);
			}
			if (request.method === "GET" && url.pathname === "/status") {
				const status = this.status(url.searchParams.get("commandId") ?? "");
				return status === null
					? json({ code: "command-not-found" }, 404)
					: json(status);
			}
			if (request.method === "GET" && url.pathname === "/watch")
				return this.watch(Number(url.searchParams.get("afterRevision") ?? 0));
			return json({ code: "mailbox-route-not-found" }, 404);
		} catch (error) {
			console.error("[workspace-mailbox] request failed", error);
			return json({ code: "mailbox-invalid-request" }, 400);
		}
	}
}
