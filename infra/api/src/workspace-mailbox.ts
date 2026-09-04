import type { DurableObjectState } from "@cloudflare/workers-types";
import { cloudCommandLane } from "@zuse/cloud-commands";
import {
	CLOUD_COMMAND_LEASE_TTL_MS,
	CLOUD_COMMAND_MAX_ENVELOPE_BYTES,
	CLOUD_COMMAND_MAX_MAILBOX_BYTES,
	CLOUD_COMMAND_MAX_NONTERMINAL,
	CLOUD_COMMAND_WATCH_MAX_CHANGES,
	CLOUD_COMMAND_WATCH_MAX_WAIT_MS,
	type CloudCommandEnvelope,
	isCloudCommandTerminalState,
	type RuntimeAcknowledgment,
} from "@zuse/contracts";

type SqlRow = Record<string, string | number | null>;

const RESERVATION_TTL_MS = 60_000;
const RESULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CHANGE_HISTORY_LIMIT = 10_000;
const DESTRUCTIVE_LEASE_CATEGORIES = [
	"workspace-destruction-fence-advanced-after-lease",
	"workspace-archived-after-lease",
	"workspace-deleted-after-lease",
] as const;

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

	private metaNumber(name: string): number | null {
		const value = this.rows(
			"SELECT value FROM mailbox_meta WHERE key = ?",
			name,
		)[0]?.value;
		if (value === undefined || value === null) return null;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) ? parsed : null;
	}

	private setMeta(name: string, value: string | number): void {
		this.sql.exec(
			"INSERT INTO mailbox_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
			name,
			String(value),
		);
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
		// Change history is bounded, while command tombstones live for the
		// workspace lifetime. Preserve the latest command revision separately so
		// targeted status recovery remains useful after a watch cursor reset.
		this.setMeta(`command-revision:${commandId}`, revision);
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
		const revision =
			this.metaNumber(`command-revision:${commandId}`) ??
			Number(
				this.rows(
					"SELECT MAX(revision) AS revision FROM mailbox_changes WHERE command_id = ?",
					commandId,
				)[0]?.revision ?? 0,
			);
		return {
			commandId: row.command_id,
			workspaceSequence: row.workspace_sequence,
			revision,
			fingerprint: row.fingerprint,
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

	private envelopeFence(row: SqlRow): number | null {
		try {
			const parsed = JSON.parse(String(row.envelope_json)) as {
				destructionFence?: unknown;
			};
			return typeof parsed.destructionFence === "number" &&
				Number.isSafeInteger(parsed.destructionFence) &&
				parsed.destructionFence >= 0
				? parsed.destructionFence
				: null;
		} catch {
			return null;
		}
	}

	private commandIdentity(envelope: CloudCommandEnvelope): string {
		return JSON.stringify([
			envelope.protocolVersion,
			envelope.workspaceId,
			envelope.sessionId,
			envelope.commandId,
			envelope.kind,
			envelope.fingerprint,
			envelope.schemaVersion,
			envelope.keyVersion,
			envelope.destructionFence,
			envelope.createdAt,
			envelope.dependencies,
		]);
	}

	private identityFromEnvelopeJson(storedEnvelopeJson: string): string | null {
		try {
			const stored = JSON.parse(storedEnvelopeJson) as CloudCommandEnvelope;
			return this.commandIdentity(stored);
		} catch {
			return null;
		}
	}

	private terminalizeUnsafe(
		rows: SqlRow[],
		categories: { neverLeased: string; everLeased: string },
	): void {
		const now = Date.now();
		for (const row of rows) {
			const commandId = String(row.command_id);
			const everLeased = row.ever_leased === 1;
			const canStillReceiveOriginalReceipt =
				everLeased &&
				row.state === "leased" &&
				typeof row.lease_token === "string" &&
				row.lease_token.length > 0 &&
				typeof row.lease_deadline === "number" &&
				row.lease_deadline > now &&
				typeof row.runtime_generation === "number" &&
				typeof row.storage_incarnation_id === "string";
			if (canStillReceiveOriginalReceipt) {
				// Destruction prevents any replay, but it does not erase knowledge held
				// by the runtime that already owned this exact lease. Keep the original
				// token only through its existing deadline so a durable receipt can
				// settle the outcome without weakening terminal-state immutability.
				this.sql.exec(
					`UPDATE mailbox_commands SET category = ?, updated_at = ?
					 WHERE command_id = ? AND state = 'leased'`,
					categories.everLeased,
					now,
					commandId,
				);
				this.changed(commandId);
				continue;
			}
			this.sql.exec(
				`UPDATE mailbox_commands SET state = ?, category = ?, updated_at = ?, terminal_at = ?,
				 lease_token = NULL, lease_deadline = NULL
				 WHERE command_id = ?
				 AND state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
				everLeased ? "outcome-unknown" : "cancelled",
				everLeased ? categories.everLeased : categories.neverLeased,
				now,
				now,
				commandId,
			);
			this.changed(commandId);
		}
	}

	private terminalizeBelowFenceUnsafe(
		destructionFence: number,
		categories: { neverLeased: string; everLeased: string },
	): void {
		const stale = this.rows(
			`SELECT command_id, ever_leased, state, lease_token, lease_deadline,
				runtime_generation, storage_incarnation_id, envelope_json
			 FROM mailbox_commands
			 WHERE state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
		).filter((row) => {
			const commandFence = this.envelopeFence(row);
			return commandFence === null || commandFence < destructionFence;
		});
		this.terminalizeUnsafe(stale, categories);
	}

	private nonterminalCountUnsafe(): number {
		return Number(
			this.rows(
				`SELECT COUNT(*) AS count FROM mailbox_commands
				 WHERE state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
			)[0]?.count ?? 0,
		);
	}

	private mailboxRevisionUnsafe(): number {
		return this.metaNumber("revision") ?? 0;
	}

	private expireLeasesUnsafe(now: number): void {
		const expiredLeases = this.rows(
			"SELECT command_id FROM mailbox_commands WHERE state = 'leased' AND lease_deadline <= ?",
			now,
		);
		this.sql.exec(
			`UPDATE mailbox_commands SET state = 'outcome-unknown', updated_at = ?,
				terminal_at = ?, lease_token = NULL, lease_deadline = NULL
			 WHERE state = 'leased' AND lease_deadline <= ?
				AND category IN (?, ?, ?)`,
			now,
			now,
			now,
			...DESTRUCTIVE_LEASE_CATEGORIES,
		);
		this.sql.exec(
			`UPDATE mailbox_commands SET state = 'lease-expired-awaiting-fence',
				category = 'runtime-fence-required', updated_at = ?
			 WHERE state = 'leased' AND lease_deadline <= ?
				AND (category IS NULL OR category NOT IN (?, ?, ?))`,
			now,
			now,
			...DESTRUCTIVE_LEASE_CATEGORIES,
		);
		for (const row of expiredLeases) this.changed(String(row.command_id));
	}

	private runtimeFenceRequiredUnsafe(
		runtimeGeneration: number,
		storageIncarnationId: string,
	): boolean {
		return (
			Number(
				this.rows(
					`SELECT COUNT(*) AS count FROM mailbox_commands
				 WHERE state = 'lease-expired-awaiting-fence'
					AND runtime_generation = ? AND storage_incarnation_id = ?`,
					runtimeGeneration,
					storageIncarnationId,
				)[0]?.count ?? 0,
			) > 0
		);
	}

	private observeDestructionFenceUnsafe(destructionFence: number): void {
		const current = this.metaNumber("destruction-fence");
		if (current !== null && destructionFence <= current) return;
		this.setMeta("destruction-fence", destructionFence);
		this.terminalizeBelowFenceUnsafe(destructionFence, {
			neverLeased: "workspace-destruction-fence-advanced",
			everLeased: "workspace-destruction-fence-advanced-after-lease",
		});
	}

	private reserveUnsafe(envelope: CloudCommandEnvelope): Response {
		const bytes = envelopeBytes(envelope);
		const lane = cloudCommandLane(envelope);
		if (lane === undefined)
			return json({ code: "cloud-command-not-eligible" }, 400);
		if (bytes > CLOUD_COMMAND_MAX_ENVELOPE_BYTES)
			return json({ code: "command-envelope-too-large" }, 413);
		if (
			!Number.isSafeInteger(envelope.destructionFence) ||
			envelope.destructionFence < 0
		)
			return json({ code: "command-destruction-fence-invalid" }, 400);
		const currentFence = this.metaNumber("destruction-fence");
		if (currentFence !== null && envelope.destructionFence < currentFence)
			return json({ code: "command-destruction-fence-stale" }, 409);
		this.observeDestructionFenceUnsafe(envelope.destructionFence);
		const identity = this.commandIdentity(envelope);
		const existing = this.rows(
			"SELECT envelope_json FROM mailbox_commands WHERE command_id = ?",
			envelope.commandId,
		)[0];
		if (existing !== undefined) {
			const storedIdentity = this.rows(
				"SELECT value FROM mailbox_meta WHERE key = ?",
				`command-identity:${envelope.commandId}`,
			)[0]?.value;
			const comparableIdentity =
				typeof storedIdentity === "string"
					? storedIdentity
					: typeof existing.envelope_json === "string"
						? this.identityFromEnvelopeJson(existing.envelope_json)
						: null;
			if (comparableIdentity !== identity)
				return json({ code: "command-identity-collision" }, 409);
			if (storedIdentity === undefined)
				this.setMeta(`command-identity:${envelope.commandId}`, identity);
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
			lane,
			envelope.kind,
			envelope.fingerprint,
			envelope.schemaVersion,
			JSON.stringify(envelope),
			bytes,
			now,
			now,
		);
		this.setMeta(`command-identity:${envelope.commandId}`, identity);
		this.changed(envelope.commandId);
		return json({
			reserved: true,
			existing: false,
			workspaceSequence: sequence,
		});
	}

	private async reserve(envelope: CloudCommandEnvelope): Promise<Response> {
		// Arm first: a DO eviction between SQLite commit and alarm scheduling must
		// not leave an abandoned reservation consuming capacity forever.
		await this.schedule(Date.now() + RESERVATION_TTL_MS);
		const response = this.state.storage.transactionSync(() =>
			this.reserveUnsafe(envelope),
		);
		if (response.ok) await this.scheduleNext();
		return response;
	}

	private commitUnsafe(commandId: string, blockedUntil?: string): Response {
		const now = Date.now();
		const before = this.rows(
			"SELECT state, accepted_at FROM mailbox_commands WHERE command_id = ?",
			commandId,
		)[0];
		if (before === undefined) return json({ code: "command-not-found" }, 404);
		this.sql.exec(
			`UPDATE mailbox_commands SET state = ?, accepted_at = ?, updated_at = ?, blocked_until = ?
			 WHERE command_id = ? AND state = 'reserved'`,
			blockedUntil === undefined ? "accepted" : "blocked",
			now,
			now,
			blockedUntil ?? null,
			commandId,
		);
		if (before.state === "reserved") this.changed(commandId);
		const current = this.status(commandId) as Record<string, unknown>;
		const acceptedAt = current.acceptedAt ?? before.accepted_at;
		if (typeof acceptedAt !== "number")
			return json(
				{
					code: "command-not-accepted",
					status: current,
				},
				409,
			);
		const acceptanceState =
			current.state === "waiting-for-runtime" || current.state === "blocked"
				? current.state
				: "accepted";
		return json(
			{
				commandId,
				workspaceSequence: current.workspaceSequence,
				revision: current.revision,
				acceptedAt,
				// Enqueue acknowledges durable acceptance even when this is a retry
				// after the command already reached a terminal state. The client checks
				// status before watching, so no terminal revision can be missed.
				state: acceptanceState,
			},
			202,
		);
	}

	private async commit(
		commandId: string,
		blockedUntil?: string,
	): Promise<Response> {
		const response = this.state.storage.transactionSync(() =>
			this.commitUnsafe(commandId, blockedUntil),
		);
		await this.scheduleNext();
		const status = this.status(commandId);
		if (response.ok)
			console.info("[workspace-mailbox] command accepted", {
				commandId,
				workspaceSequence: status?.workspaceSequence,
				revision: status?.revision,
			});
		return response;
	}

	private blockUnsafe(
		commandId: string | undefined,
		blockedUntil: string,
	): Response {
		if (commandId === undefined) {
			const candidates = this.rows(
				`SELECT command_id, state, blocked_until FROM mailbox_commands
				 WHERE ever_leased = 0
				 AND state IN ('accepted','waiting-for-runtime','blocked')
				 ORDER BY workspace_sequence`,
			);
			const now = Date.now();
			let changed = 0;
			for (const candidate of candidates) {
				if (
					candidate.state === "blocked" &&
					candidate.blocked_until === blockedUntil
				)
					continue;
				const blockedCommandId = String(candidate.command_id);
				this.sql.exec(
					`UPDATE mailbox_commands SET state = 'blocked', blocked_until = ?, updated_at = ?
					 WHERE command_id = ? AND ever_leased = 0
					 AND state IN ('accepted','waiting-for-runtime','blocked')`,
					blockedUntil,
					now,
					blockedCommandId,
				);
				this.changed(blockedCommandId);
				changed += 1;
			}
			return json({ blocked: changed }, 202);
		}
		const before = this.status(commandId);
		if (before === null) return json({ code: "command-not-found" }, 404);
		if (isCloudCommandTerminalState(before.state)) return json(before);
		if (before.state === "reserved")
			return json({ code: "command-not-accepted", status: before }, 409);
		if (before.state === "leased" || before.everLeased === true)
			return json({ code: "command-already-leased", status: before }, 409);
		const now = Date.now();
		this.sql.exec(
			`UPDATE mailbox_commands SET state = 'blocked', blocked_until = ?, updated_at = ?
			 WHERE command_id = ? AND state IN ('accepted','waiting-for-runtime','blocked')`,
			blockedUntil,
			now,
			commandId,
		);
		if (before.state !== "blocked" || before.blockedUntil !== blockedUntil)
			this.changed(commandId);
		return json(this.status(commandId), 202);
	}

	private async block(
		commandId: string | undefined,
		blockedUntil: string,
	): Promise<Response> {
		const response = this.state.storage.transactionSync(() =>
			this.blockUnsafe(commandId, blockedUntil),
		);
		await this.scheduleNext();
		return response;
	}

	private unblockUnsafe(commandId?: string, blockedUntil?: string): Response {
		if (commandId === undefined) {
			const blocked =
				blockedUntil === undefined
					? this.rows(
							"SELECT command_id FROM mailbox_commands WHERE state = 'blocked' ORDER BY workspace_sequence",
						)
					: this.rows(
							`SELECT command_id FROM mailbox_commands
							 WHERE state = 'blocked' AND blocked_until = ? ORDER BY workspace_sequence`,
							blockedUntil,
						);
			const now = Date.now();
			for (const row of blocked) {
				const blockedCommandId = String(row.command_id);
				this.sql.exec(
					`UPDATE mailbox_commands SET state = 'waiting-for-runtime', blocked_until = NULL,
					 updated_at = ? WHERE command_id = ? AND state = 'blocked'`,
					now,
					blockedCommandId,
				);
				this.changed(blockedCommandId);
			}
			return json({ unblocked: blocked.length });
		}
		const before = this.status(commandId);
		if (before === null) return json({ code: "command-not-found" }, 404);
		if (before.state !== "blocked") return json(before);
		if (blockedUntil !== undefined && before.blockedUntil !== blockedUntil)
			return json(
				{ code: "command-block-reason-mismatch", status: before },
				409,
			);
		const now = Date.now();
		this.sql.exec(
			`UPDATE mailbox_commands SET state = 'waiting-for-runtime', blocked_until = NULL,
			 updated_at = ? WHERE command_id = ? AND state = 'blocked'`,
			now,
			commandId,
		);
		this.changed(commandId);
		return json(this.status(commandId));
	}

	private async unblock(
		commandId?: string,
		blockedUntil?: string,
	): Promise<Response> {
		const response = this.state.storage.transactionSync(() =>
			this.unblockUnsafe(commandId, blockedUntil),
		);
		await this.scheduleNext();
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
		return isCloudCommandTerminalState(status.state)
			? json(this.status(commandId))
			: json({ code: "command-already-leased", status }, 409);
	}

	private async cancel(
		commandId: string,
		category = "cancelled-by-user",
	): Promise<Response> {
		await this.schedule(Date.now() + RESULT_RETENTION_MS);
		const response = this.state.storage.transactionSync(() =>
			this.cancelUnsafe(commandId, category),
		);
		await this.scheduleNext();
		return response;
	}

	private leaseUnsafe(input: {
		runtimeGeneration: number;
		providerSandboxId: string;
		storageIncarnationId: string;
		destructionFence: number;
	}): Response {
		const now = Date.now();
		if (
			!Number.isSafeInteger(input.runtimeGeneration) ||
			input.runtimeGeneration < 1 ||
			!Number.isSafeInteger(input.destructionFence) ||
			input.destructionFence < 0
		)
			return json({ code: "runtime-fence-invalid" }, 400);
		this.expireLeasesUnsafe(now);
		const knownRuntimeGeneration = this.metaNumber("runtime-generation");
		if (
			knownRuntimeGeneration !== null &&
			input.runtimeGeneration < knownRuntimeGeneration
		)
			return json({
				leases: [],
				fenced: true,
				nonterminalCount: this.nonterminalCountUnsafe(),
				mailboxRevision: this.mailboxRevisionUnsafe(),
				fenceRequired: false,
			});
		if (
			knownRuntimeGeneration === null ||
			input.runtimeGeneration > knownRuntimeGeneration
		)
			this.setMeta("runtime-generation", input.runtimeGeneration);
		const knownDestructionFence = this.metaNumber("destruction-fence");
		if (
			knownDestructionFence !== null &&
			input.destructionFence < knownDestructionFence
		) {
			// A runtime authenticated against an older lifecycle view must not see
			// work from the new incarnation. An empty successful poll lets that old
			// consumer stop cleanly once its credential is fenced without spinning
			// on a permanent request failure.
			return json({
				leases: [],
				fenced: true,
				nonterminalCount: this.nonterminalCountUnsafe(),
				mailboxRevision: this.mailboxRevisionUnsafe(),
				fenceRequired: false,
			});
		}
		this.observeDestructionFenceUnsafe(input.destructionFence);
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
				 updated_at = ?, terminal_at = ?, lease_token = NULL, lease_deadline = NULL
				 WHERE ever_leased = 1
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
		const fenceRequired = this.runtimeFenceRequiredUnsafe(
			input.runtimeGeneration,
			input.storageIncarnationId,
		);
		if (fenceRequired)
			return json({
				leases: [],
				nonterminalCount: this.nonterminalCountUnsafe(),
				mailboxRevision: this.mailboxRevisionUnsafe(),
				fenceRequired: true,
			});
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
			const deadline = now + CLOUD_COMMAND_LEASE_TTL_MS;
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
				providerSandboxId: input.providerSandboxId,
				storageIncarnationId: input.storageIncarnationId,
			});
		}
		if (leases.length > 0)
			console.info("[workspace-mailbox] commands leased", {
				runtimeGeneration: input.runtimeGeneration,
				storageIncarnationId: input.storageIncarnationId,
				count: leases.length,
			});
		return json({
			leases,
			nonterminalCount: this.nonterminalCountUnsafe(),
			mailboxRevision: this.mailboxRevisionUnsafe(),
			fenceRequired: false,
		});
	}

	private async lease(input: {
		runtimeGeneration: number;
		providerSandboxId: string;
		storageIncarnationId: string;
		destructionFence: number;
	}): Promise<Response> {
		await this.schedule(Date.now() + CLOUD_COMMAND_LEASE_TTL_MS);
		const response = this.state.storage.transactionSync(() =>
			this.leaseUnsafe(input),
		);
		await this.scheduleNext();
		return response;
	}

	private acknowledgeUnsafe(ack: RuntimeAcknowledgment): Response {
		const now = Date.now();
		// Enforce the bounded destructive-lifecycle grace window even when an ACK
		// races the alarm. Ordinary expired leases remain receipt-eligible until
		// their runtime generation is fenced; lifecycle-fenced leases do not.
		this.expireLeasesUnsafe(now);
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
		if (row.fingerprint !== ack.fingerprint)
			return json({ code: "command-fingerprint-mismatch" }, 409);
		if (isCloudCommandTerminalState(row.state))
			return json(this.status(ack.commandId));
		if (
			(row.state !== "leased" &&
				row.state !== "lease-expired-awaiting-fence") ||
			row.lease_token !== ack.leaseToken
		)
			// This is a permanent receipt outcome, not a retryable transport error.
			// A newer fenced lease (or lifecycle transition) now owns the command.
			return json({
				acknowledged: false,
				code: "stale-runtime-lease",
				status: this.status(ack.commandId),
			});
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

	private async acknowledge(ack: RuntimeAcknowledgment): Promise<Response> {
		await this.schedule(Date.now() + RESULT_RETENTION_MS);
		const response = this.state.storage.transactionSync(() =>
			this.acknowledgeUnsafe(ack),
		);
		await this.scheduleNext();
		console.info("[workspace-mailbox] command acknowledgment processed", {
			commandId: ack.commandId,
			requestedState: ack.state,
			category: ack.category,
			httpStatus: response.status,
		});
		return response;
	}

	private async lifecycle(
		action: "archive" | "delete",
		destructionFence?: number,
	): Promise<Response> {
		await this.schedule(Date.now() + RESULT_RETENTION_MS);
		const response = this.state.storage.transactionSync(() => {
			if (
				destructionFence !== undefined &&
				(!Number.isSafeInteger(destructionFence) || destructionFence < 0)
			)
				return json({ code: "workspace-destruction-fence-invalid" }, 400);

			if (destructionFence !== undefined) {
				const processedFence = this.metaNumber("lifecycle-fence");
				if (processedFence !== null && destructionFence <= processedFence)
					return json({ ok: true, duplicate: true });
				const knownFence = this.metaNumber("destruction-fence");
				if (knownFence !== null && destructionFence < knownFence)
					return json({ ok: true, stale: true });
				this.setMeta("destruction-fence", destructionFence);
				this.setMeta("lifecycle-fence", destructionFence);
				this.terminalizeBelowFenceUnsafe(destructionFence, {
					neverLeased: `workspace-${action}d-before-lease`,
					everLeased: `workspace-${action}d-after-lease`,
				});
			} else {
				// Compatibility for a control plane deployed before lifecycle fences
				// were forwarded. It is intentionally conservative: no accepted work
				// may remain replayable after a destructive lifecycle request.
				const nonterminal = this.rows(
					`SELECT command_id, ever_leased, state, lease_token, lease_deadline,
						runtime_generation, storage_incarnation_id
					 FROM mailbox_commands
					 WHERE state NOT IN ('applied','rejected','expired','cancelled','outcome-unknown')`,
				);
				this.terminalizeUnsafe(nonterminal, {
					neverLeased: `workspace-${action}d-before-lease`,
					everLeased: `workspace-${action}d-after-lease`,
				});
			}
			return json({ ok: true });
		});
		await this.scheduleNext();
		return response;
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
			// A reset is a handshake, not a partial workspace snapshot. There can be
			// 256 pending commands but a page holds only 100, so returning an arbitrary
			// subset and advancing to `current` would silently lose pending IDs. The
			// caller recovers its own durable pending IDs through /status, then resumes
			// from nextRevision.
			if (resetRequired)
				return {
					changes: [],
					nextRevision: current,
					resetRequired: true,
				};
			const ids = this.rows(
				`SELECT command_id, MAX(revision) AS revision FROM mailbox_changes
				 WHERE revision > ? GROUP BY command_id ORDER BY revision LIMIT ?`,
				afterRevision,
				CLOUD_COMMAND_WATCH_MAX_CHANGES,
			);
			const lastRevision = ids.at(-1)?.revision;
			return {
				changes: ids
					.map((row) => this.status(String(row.command_id)))
					.filter(Boolean),
				// Advance only through the last command represented in this page. A
				// second page therefore cannot be skipped when >100 commands changed.
				nextRevision:
					lastRevision === undefined || lastRevision === null
						? current
						: Number(lastRevision),
				resetRequired: false,
			};
		};
		let page = read();
		if (
			!page.resetRequired &&
			page.changes.length === 0 &&
			page.nextRevision <= afterRevision
		) {
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
		if (current === null || current <= Date.now() || at < current)
			await this.state.storage.setAlarm(at);
	}

	private nextAlarmDeadline(): number | null {
		const deadline = this.rows(
			`SELECT MIN(deadline) AS deadline FROM (
				SELECT updated_at + ? AS deadline FROM mailbox_commands WHERE state = 'reserved'
				UNION ALL SELECT lease_deadline AS deadline FROM mailbox_commands WHERE state = 'leased'
				UNION ALL SELECT terminal_at + ? AS deadline FROM mailbox_commands
					WHERE terminal_at IS NOT NULL
					AND (envelope_json != '' OR result_iv IS NOT NULL OR result_ciphertext IS NOT NULL)
			)`,
			RESERVATION_TTL_MS,
			RESULT_RETENTION_MS,
		)[0]?.deadline;
		return deadline === undefined || deadline === null
			? null
			: Number(deadline);
	}

	private async scheduleNext(): Promise<void> {
		const deadline = this.nextAlarmDeadline();
		if (deadline === null) {
			await this.state.storage.deleteAlarm();
			return;
		}
		await this.schedule(Math.max(Date.now() + 1, deadline));
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		this.state.storage.transactionSync(() => {
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
			this.expireLeasesUnsafe(now);
			this.sql.exec(
				`UPDATE mailbox_commands SET result_iv = NULL, result_ciphertext = NULL,
				 envelope_json = '', envelope_bytes = 0,
				 category = CASE WHEN category IS NULL THEN 'result-expired' ELSE category END
				 WHERE terminal_at IS NOT NULL AND terminal_at <= ?`,
				now - RESULT_RETENTION_MS,
			);
		});
		await this.scheduleNext();
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (request.method === "POST" && url.pathname === "/reserve")
				return this.reserve((await request.json()) as CloudCommandEnvelope);
			if (request.method === "POST" && url.pathname === "/commit") {
				const body = (await request.json()) as {
					commandId: string;
					blockedUntil?: string;
				};
				return this.commit(body.commandId, body.blockedUntil);
			}
			if (request.method === "POST" && url.pathname === "/block") {
				const body = (await request.json()) as {
					commandId?: string;
					blockedUntil: string;
				};
				if (
					typeof body.blockedUntil !== "string" ||
					body.blockedUntil.length === 0
				)
					return json({ code: "command-block-reason-invalid" }, 400);
				return this.block(body.commandId, body.blockedUntil);
			}
			if (request.method === "POST" && url.pathname === "/unblock") {
				const body = (await request.json()) as {
					commandId?: string;
					blockedUntil?: string;
				};
				return this.unblock(body.commandId, body.blockedUntil);
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
				const body = (await request.json()) as {
					action: "archive" | "delete";
					destructionFence?: number;
				};
				if (body.action !== "archive" && body.action !== "delete")
					return json({ code: "invalid-lifecycle-action" }, 400);
				return this.lifecycle(body.action, body.destructionFence);
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
