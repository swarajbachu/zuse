import type { WebSocket as CloudflareWebSocket } from "@cloudflare/workers-types";
import { AutomationDispatchInput } from "@zuse/contracts";
import type { Cipher } from "@zuse/slack/installations";
import { matchesAutomationEvent } from "@zuse/utils/automation-events";
import {
	nextScheduledAt,
	validateSchedule,
} from "@zuse/utils/automation-schedule";
import { Schema } from "effect";
import {
	type AutomationExternalEvent,
	AutomationRegistration,
} from "./automation-mailbox.ts";

const TTL = 7 * 24 * 60 * 60_000;
const RETRY = 60_000;
export const AUTOMATION_OWNER_CAPACITY_BYTES = 8 * 1024 * 1024;
// Reserve room for ACK/rejection metadata and notification delivery receipts.
const CAPACITY_RESERVE = 2 * 1024 * 1024;
const MAX_RECORDS = 2000;
class AutomationCapacityError extends Error {
	constructor() {
		super("automation_owner_capacity_exceeded");
	}
}
const retainedBytes = (records: Map<string, RecordValue>) => {
	let bytes = 0;
	for (const [k, v] of records)
		bytes += new TextEncoder().encode(k + JSON.stringify(v)).byteLength;
	return bytes;
};
const assertCapacity = (
	records: Map<string, RecordValue>,
	reserve = CAPACITY_RESERVE,
) => {
	if (
		records.size > MAX_RECORDS - (reserve > 0 ? 100 : 0) ||
		retainedBytes(records) > AUTOMATION_OWNER_CAPACITY_BYTES - reserve
	)
		throw new AutomationCapacityError();
};
type Registration = {
	workspace_id: string;
	account_id: string;
	automation_id: string;
	revision: number;
	enabled: boolean;
	sealed: string;
	webhook_token_sealed: string;
	next_run_at: number | null;
};
type Event = {
	id: string;
	workspace_id: string;
	automation_id: string;
	revision: number;
	event_id: string;
	source: string;
	sealed: string;
	created_at: number;
	expires_at: number;
	acknowledged_at?: number | null;
	completed_at?: number | null;
	rejected_reason?: string | null;
};
type Receipt = {
	workspace_id: string;
	automation_id: string;
	run_id: string;
	destination: string;
	delivered_at: number;
};
type RecordValue = Registration | Event | Receipt | string | number;
type TransactionStore = {
	list<T>(): Promise<Map<string, T>>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<unknown>;
	setAlarm(time: number): Promise<void>;
	deleteAlarm(): Promise<void>;
};
type Store = TransactionStore & {
	transaction<T>(
		callback: (storage: TransactionStore) => Promise<T>,
	): Promise<T>;
};
declare const WebSocketPair: {
	new (): { 0: CloudflareWebSocket; 1: CloudflareWebSocket };
};
export interface AutomationObjectState {
	storage: Store;
	blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
	getWebSockets(tag?: string): CloudflareWebSocket[];
	acceptWebSocket(socket: CloudflareWebSocket, tags?: string[]): void;
}
export interface AutomationObjectCallbacks {
	cipher: Cipher;
	wake(workspaceId: string, accountId: string): Promise<boolean>;
	now?: () => number;
}
const key = (...parts: string[]) => parts.map(encodeURIComponent).join(":");
const registrationContext = (workspace: string, id: string) =>
	`automation-registration:${workspace}:${id}`;
const eventContext = (workspace: string, id: string) =>
	`automation-event:${workspace}:${id}`;

/** One owner per object. Storage and alarm changes commit before any external wake. */
export class AutomationDurableObjectCore {
	constructor(
		private readonly state: AutomationObjectState,
		private readonly callbacks: AutomationObjectCallbacks,
	) {}
	private now() {
		return this.callbacks.now?.() ?? Date.now();
	}
	private async definitions(records: Map<string, RecordValue>) {
		const result: { row: Registration; definition: AutomationRegistration }[] =
			[];
		for (const [k, value] of records)
			if (k.startsWith("r:")) {
				const row = value as Registration;
				const definition = Schema.decodeUnknownSync(AutomationRegistration)(
					JSON.parse(
						await this.callbacks.cipher.open(
							registrationContext(row.workspace_id, row.automation_id),
							row.sealed,
						),
					),
				);
				result.push({ row, definition });
			}
		return result;
	}
	private events(records: Map<string, RecordValue>) {
		return [...records]
			.filter(([k]) => k.startsWith("e:"))
			.map(([, v]) => v as Event);
	}
	private eligible(records: Map<string, RecordValue>, event: Event) {
		const row = records.get(
			key("r", event.workspace_id, event.automation_id),
		) as Registration | undefined;
		return (
			row?.enabled &&
			row.revision === event.revision &&
			event.expires_at > this.now()
		);
	}
	private async enqueue(
		records: Map<string, RecordValue>,
		row: Registration,
		event: AutomationExternalEvent,
	) {
		if (
			Object.keys(event.context).length > 99 ||
			JSON.stringify(event.context).length > 59000 ||
			Object.hasOwn(event.context, "mailboxEventId")
		)
			throw new Error("automation_event_reserved_context");
		const input = Schema.decodeUnknownSync(AutomationDispatchInput)({
			automationId: row.automation_id,
			...event,
		});
		if (
			this.events(records).some(
				(e) =>
					e.workspace_id === row.workspace_id &&
					e.automation_id === row.automation_id &&
					e.source === event.source &&
					e.event_id === event.eventId,
			)
		)
			return;
		const id = crypto.randomUUID();
		records.set(key("e", id), {
			id,
			workspace_id: row.workspace_id,
			automation_id: row.automation_id,
			revision: row.revision,
			event_id: event.eventId,
			source: event.source,
			sealed: await this.callbacks.cipher.seal(
				eventContext(row.workspace_id, id),
				JSON.stringify(input),
			),
			created_at: this.now(),
			expires_at: this.now() + TTL,
		});
		try {
			assertCapacity(records);
		} catch (error) {
			records.delete(key("e", id));
			throw error;
		}
	}
	private async decode(event: Event) {
		return Schema.decodeUnknownSync(AutomationDispatchInput)(
			JSON.parse(
				await this.callbacks.cipher.open(
					eventContext(event.workspace_id, event.id),
					event.sealed,
				),
			),
		);
	}
	private prune(records: Map<string, RecordValue>) {
		for (const [k, v] of records) {
			if (k.startsWith("e:") && (v as Event).expires_at <= this.now())
				records.delete(k);
			if (k.startsWith("n:") && (v as Receipt).delivered_at + TTL <= this.now())
				records.delete(k);
		}
	}
	private async persist(
		before: Map<string, RecordValue>,
		records: Map<string, RecordValue>,
	) {
		this.prune(records);
		const pending = this.events(records).filter(
			(e) => e.acknowledged_at == null && this.eligible(records, e),
		);
		if (!pending.length) records.delete("retry");
		else if (!records.has("retry")) records.set("retry", this.now());
		const deadlines: number[] = [];
		for (const [k, v] of records) {
			if (k.startsWith("r:")) {
				const row = v as Registration;
				if (row.enabled && row.next_run_at !== null)
					deadlines.push(
						Math.max(
							row.next_run_at,
							Number(records.get("capacityRetry") ?? 0),
						),
					);
			}
			if (k.startsWith("e:")) deadlines.push((v as Event).expires_at);
			if (k.startsWith("n:")) deadlines.push((v as Receipt).delivered_at + TTL);
		}
		if (records.has("retry")) deadlines.push(Number(records.get("retry")));
		await this.state.storage.transaction(async (storage) => {
			for (const k of before.keys())
				if (!records.has(k)) await storage.delete(k);
			for (const [k, v] of records)
				if (JSON.stringify(before.get(k)) !== JSON.stringify(v))
					await storage.put(k, v);
			if (deadlines.length)
				await storage.setAlarm(
					Math.max(this.now() + 1, Math.min(...deadlines)),
				);
			else await storage.deleteAlarm();
		});
	}
	private async notify(records: Map<string, RecordValue>) {
		const workspaces = new Set(
			this.events(records)
				.filter((e) => e.acknowledged_at == null && this.eligible(records, e))
				.map((e) => e.workspace_id),
		);
		await Promise.allSettled(
			[...workspaces].map(async (workspaceId) => {
				// Recheck authoritative ownership even when a stale socket remains connected.
				const active = await this.callbacks.wake(
					workspaceId,
					String(records.get("owner")),
				);
				if (!active) {
					await this.fetch(
						new Request("https://automation.internal/remove-workspace", {
							method: "POST",
							body: JSON.stringify({
								accountId: records.get("owner"),
								workspaceId,
							}),
						}),
					);
					return;
				}
				for (const socket of this.state.getWebSockets(workspaceId))
					try {
						socket.send(JSON.stringify({ type: "available" }));
					} catch {
						/* Durable pending event remains retryable. */
					}
			}),
		);
	}

	async alarm(): Promise<void> {
		const pending = await this.state.blockConcurrencyWhile(async () => {
			const before = await this.state.storage.list<RecordValue>();
			const records = new Map(before);
			this.prune(records);
			let emitted = 0;
			for (const { row, definition } of await this.definitions(records)) {
				if (
					!row.enabled ||
					row.next_run_at === null ||
					row.next_run_at > this.now() ||
					Number(records.get("capacityRetry") ?? 0) > this.now() ||
					emitted >= 100
				)
					continue;
				const occurrence = new Date(row.next_run_at);
				try {
					await this.enqueue(records, row, {
						source: "schedule",
						eventId: occurrence.toISOString(),
						prompt: "",
						context: { scheduledAt: occurrence.toISOString() },
					});
				} catch (error) {
					if (!(error instanceof AutomationCapacityError)) throw error;
					records.set("capacityRetry", this.now() + RETRY);
					break;
				}
				records.delete("capacityRetry");
				const next = definition.triggers.flatMap((t) =>
					t._tag === "schedule"
						? [nextScheduledAt(t, occurrence)?.getTime()].filter(
								(v): v is number => v !== undefined,
							)
						: [],
				);
				records.set(key("r", row.workspace_id, row.automation_id), {
					...row,
					next_run_at: next.length ? Math.min(...next) : null,
				});
				emitted++;
			}
			const shouldNotify =
				emitted > 0 || Number(records.get("retry") ?? Infinity) <= this.now();
			if (shouldNotify) records.set("retry", this.now() + RETRY);
			await this.persist(before, records);
			return shouldNotify ? records : undefined;
		});
		if (pending) await this.notify(pending);
	}
	async fetch(request: Request): Promise<Response> {
		return this.state
			.blockConcurrencyWhile(async () => {
				const url = new URL(request.url);
				const body =
					url.pathname === "/connect"
						? Object.fromEntries(url.searchParams)
						: ((await request.json()) as Record<string, unknown>);
				const accountId = String(body.accountId ?? "");
				if (!accountId)
					return Response.json({ error: "account_required" }, { status: 400 });
				const before = await this.state.storage.list<RecordValue>();
				const records = new Map(before);
				if (records.has("owner") && records.get("owner") !== accountId)
					return Response.json({ error: "owner_mismatch" }, { status: 403 });
				records.set("owner", accountId);
				this.prune(records);
				const workspaceId = String(body.workspaceId ?? "");
				let result: unknown = { ok: true };
				switch (url.pathname) {
					case "/initialized":
						return Response.json({ initialized: records.has("imported") });
					case "/register": {
						const definitions = Schema.decodeUnknownSync(
							Schema.Array(AutomationRegistration),
						)(body.definitions);
						if (
							new Set(definitions.map((d) => d.id)).size !== definitions.length
						)
							throw new Error("duplicate_automation_id");
						for (const definition of definitions) {
							for (const trigger of definition.triggers)
								if (trigger._tag === "schedule") validateSchedule(trigger);
							const cursor = definition.nextRunAt
								? Date.parse(definition.nextRunAt)
								: null;
							if (cursor !== null && !Number.isFinite(cursor))
								throw new Error("invalid_schedule_cursor");
							const k = key("r", workspaceId, definition.id);
							const old = records.get(k) as Registration | undefined;
							if (old && old.revision > definition.revision)
								throw new Error("stale_automation_revision");
							const context = registrationContext(workspaceId, definition.id);
							records.set(k, {
								workspace_id: workspaceId,
								account_id: accountId,
								automation_id: definition.id,
								revision: definition.revision,
								enabled: definition.enabled,
								sealed: await this.callbacks.cipher.seal(
									context,
									JSON.stringify(definition),
								),
								webhook_token_sealed:
									old?.webhook_token_sealed ??
									(await this.callbacks.cipher.seal(
										`${context}:hook`,
										[...crypto.getRandomValues(new Uint8Array(32))]
											.map((b) => b.toString(16).padStart(2, "0"))
											.join(""),
									)),
								next_run_at:
									old?.revision === definition.revision
										? old.next_run_at
										: cursor,
							});
						}
						for (const [k, v] of records)
							if (
								k.startsWith("r:") &&
								(v as Registration).workspace_id === workspaceId &&
								!definitions.some(
									(d) => d.id === (v as Registration).automation_id,
								)
							)
								records.delete(k);
						const hooks = [];
						for (const { row } of await this.definitions(records))
							if (row.workspace_id === workspaceId && row.enabled)
								hooks.push({
									automationId: row.automation_id,
									token: await this.callbacks.cipher.open(
										`${registrationContext(workspaceId, row.automation_id)}:hook`,
										row.webhook_token_sealed,
									),
								});
						result = { hooks };
						break;
					}
					case "/dispatch": {
						let accepted = 0;
						const event = body.event as AutomationExternalEvent;
						for (const { row, definition } of await this.definitions(records))
							if (
								row.enabled &&
								(!body.workspaceIds ||
									(body.workspaceIds as string[]).includes(row.workspace_id)) &&
								definition.triggers.some((t) =>
									matchesAutomationEvent(t, event),
								)
							) {
								await this.enqueue(records, row, event);
								accepted++;
							}
						result = { accepted };
						break;
					}
					case "/webhook": {
						const automationId = String(body.automationId);
						const row = records.get(key("r", workspaceId, automationId)) as
							| Registration
							| undefined;
						let accepted = false;
						if (row?.enabled && /^[a-f0-9]{64}$/u.test(String(body.token))) {
							const expected = await this.callbacks.cipher.open(
								`${registrationContext(workspaceId, automationId)}:hook`,
								row.webhook_token_sealed,
							);
							const token = String(body.token);
							let mismatch = expected.length ^ token.length;
							for (let i = 0; i < token.length; i++)
								mismatch |= token.charCodeAt(i) ^ (expected.charCodeAt(i) || 0);
							const definition = (await this.definitions(records)).find(
								(d) => d.row === row,
							)?.definition;
							if (
								mismatch === 0 &&
								definition?.triggers.some((t) =>
									matchesAutomationEvent(
										t,
										body.event as AutomationExternalEvent,
									),
								)
							) {
								await this.enqueue(
									records,
									row,
									body.event as AutomationExternalEvent,
								);
								accepted = true;
							}
						}
						result = { accepted };
						break;
					}
					case "/pending":
						result = {
							events: await Promise.all(
								this.events(records)
									.filter(
										(e) =>
											e.workspace_id === workspaceId &&
											e.acknowledged_at == null &&
											this.eligible(records, e),
									)
									.sort(
										(a, b) =>
											a.created_at - b.created_at || a.id.localeCompare(b.id),
									)
									.slice(0, 20)
									.map(async (e) => ({ id: e.id, ...(await this.decode(e)) })),
							),
						};
						break;
					case "/ack":
					case "/complete":
					case "/result": {
						const k = key("e", String(body.id));
						const event = records.get(k) as Event | undefined;
						if (url.pathname === "/result")
							result = {
								event:
									event?.workspace_id === workspaceId &&
									event.completed_at == null &&
									records.has(key("r", workspaceId, event.automation_id))
										? { ...(await this.decode(event)), accountId }
										: null,
							};
						else if (event?.workspace_id === workspaceId)
							records.set(
								k,
								url.pathname === "/ack"
									? {
											...event,
											acknowledged_at: this.now(),
											rejected_reason: body.rejection
												? String(body.rejection).slice(0, 128)
												: null,
										}
									: { ...event, completed_at: this.now() },
							);
						break;
					}
					case "/notification-target": {
						const definition = (await this.definitions(records)).find(
							(d) =>
								d.row.workspace_id === workspaceId &&
								d.row.automation_id === body.automationId,
						)?.definition;
						result = {
							target: definition?.notifications?.some(
								(n) =>
									n.channel === "slack" && n.destination === body.destination,
							)
								? {
										accountId,
										delivered: records.has(
											key(
												"n",
												workspaceId,
												String(body.automationId),
												String(body.runId),
												String(body.destination),
											),
										),
									}
								: null,
						};
						break;
					}
					case "/notification-delivered": {
						const receipt = {
							workspace_id: workspaceId,
							automation_id: String(body.automationId),
							run_id: String(body.runId),
							destination: String(body.destination),
							delivered_at: this.now(),
						};
						const k = key(
							"n",
							workspaceId,
							receipt.automation_id,
							receipt.run_id,
							receipt.destination,
						);
						if (!records.has(k)) records.set(k, receipt);
						break;
					}
					case "/remove-workspace": {
						for (const [k, v] of records)
							if (typeof v === "object" && v.workspace_id === workspaceId)
								records.delete(k);
						break;
					}
					case "/import": {
						// Legacy ciphertext contexts are retained so hooks and in-flight result IDs survive cutover.
						if (!records.has("imported")) {
							for (const row of (body.registrations ?? []) as Registration[])
								if (
									row.account_id === accountId &&
									!records.has(key("r", row.workspace_id, row.automation_id))
								)
									records.set(
										key("r", row.workspace_id, row.automation_id),
										row,
									);
							for (const event of (body.events ?? []) as Event[])
								if (
									records.has(
										key("r", event.workspace_id, event.automation_id),
									) &&
									!records.has(key("e", event.id))
								)
									records.set(key("e", event.id), event);
							for (const receipt of (body.notifications ?? []) as Receipt[])
								if (
									records.has(
										key("r", receipt.workspace_id, receipt.automation_id),
									)
								)
									records.set(
										key(
											"n",
											receipt.workspace_id,
											receipt.automation_id,
											receipt.run_id,
											receipt.destination,
										),
										receipt,
									);
							records.set("imported", this.now());
						}
						break;
					}
					case "/connect": {
						if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket")
							return new Response("WebSocket required", { status: 426 });
						const pair = new WebSocketPair();
						this.state.acceptWebSocket(pair[1], [workspaceId]);
						pair[1].serializeAttachment({ workspaceId });
						await this.persist(before, records);
						if (
							this.events(records).some(
								(e) =>
									e.workspace_id === workspaceId &&
									e.acknowledged_at == null &&
									this.eligible(records, e),
							)
						)
							pair[1].send(JSON.stringify({ type: "available" }));
						return new Response(null, {
							status: 101,
							headers: { "Sec-WebSocket-Protocol": "zuse-automation-events" },
							webSocket: pair[0],
						} as ResponseInit & { webSocket: CloudflareWebSocket });
					}
					default:
						return new Response("Not found", { status: 404 });
				}
				if (
					["/register", "/import", "/notification-delivered"].includes(
						url.pathname,
					) &&
					retainedBytes(records) > retainedBytes(before)
				) {
					assertCapacity(
						records,
						url.pathname === "/notification-delivered" ? 0 : CAPACITY_RESERVE,
					);
				}
				await this.persist(before, records);
				return Response.json(result);
			})
			.catch((error) => {
				if (error instanceof AutomationCapacityError)
					return Response.json(
						{ error: error.message, retryable: true },
						{ status: 503, headers: { "Retry-After": "60" } },
					);
				throw error;
			});
	}
	webSocketMessage(
		_socket: CloudflareWebSocket,
		_message: string | ArrayBuffer,
	) {
		/* Runtime uses authenticated HTTP ACKs. */
	}
	webSocketClose(socket: CloudflareWebSocket, _code: number, _reason: string) {
		try {
			socket.close(1000, "Runtime disconnected");
		} catch {
			/* Already closed. */
		}
	}
	webSocketError(socket: CloudflareWebSocket) {
		try {
			socket.close(1011, "Runtime connection failed");
		} catch {
			/* Already closed. */
		}
	}
}
