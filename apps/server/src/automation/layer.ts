import { randomUUID } from "node:crypto";
import {
	AgentTurnId,
	type Automation,
	AutomationConfig,
	AutomationDispatchInput,
	AutomationError,
	type AutomationRun,
	ChatId,
	type FolderId,
	SessionId,
} from "@zuse/contracts";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import {
	Effect,
	Layer,
	Option,
	PubSub,
	Queue,
	Schedule,
	Schema,
	Semaphore,
	Stream,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
	ChatService,
	MessageService,
	SessionService,
} from "../conversation/services/conversation-services.ts";
import { CredentialsService } from "../provider/services/credentials-service.ts";
import { AutomationCloudLauncher } from "./cloud-launcher.ts";
import { deliverAutomationNotification } from "./notification.ts";
import { automationPolicyError, matchesAutomationTrigger } from "./policy.ts";
import { AutomationRegistry } from "./registry-service.ts";
import { nextScheduledAt, validateSchedule } from "./schedule.ts";

type DefinitionRow = {
	id: string;
	config_json: string;
	revision: number;
	created_at: string;
	updated_at: string;
	next_run_at: string | null;
	webhook_json?: string | null;
};
type RunRow = {
	id: string;
	automation_id: string;
	event_id: string;
	source: string;
	status: AutomationRun["status"];
	session_id: string | null;
	chat_id: string | null;
	config_json: string;
	prompt: string;
	context_json: string;
	created_at: string;
	started_at: string | null;
	finished_at: string | null;
	error: string | null;
	cloud_provider_id?: string | null;
	cloud_workspace_id?: string | null;
};
const decodeConfig = (json: string) =>
	Schema.decodeUnknownSync(AutomationConfig)(JSON.parse(json));
const definition = (row: DefinitionRow): Automation => ({
	id: row.id,
	config: decodeConfig(row.config_json),
	revision: row.revision,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
	nextRunAt: row.next_run_at,
});
const runRecord = (row: RunRow): AutomationRun => ({
	id: row.id,
	automationId: row.automation_id,
	eventId: row.event_id,
	source: row.source,
	status: row.status,
	sessionId: row.session_id === null ? null : SessionId.make(row.session_id),
	chatId: row.chat_id,
	createdAt: row.created_at,
	startedAt: row.started_at,
	finishedAt: row.finished_at,
	error: row.error,
	cloudProviderId: row.cloud_provider_id ?? null,
	cloudWorkspaceId: row.cloud_workspace_id ?? null,
});
const error = (cause: unknown) =>
	cause instanceof AutomationError
		? cause
		: new AutomationError({
				message: cause instanceof Error ? cause.message : String(cause),
			});
const nextAt = (config: AutomationConfig, after: Date) => {
	const dates = config.triggers.flatMap((trigger) =>
		trigger._tag === "schedule"
			? [nextScheduledAt(trigger, after)].filter(
					(date): date is Date => date !== null,
				)
			: [],
	);
	return dates.length
		? new Date(Math.min(...dates.map((date) => date.getTime()))).toISOString()
		: null;
};

export const AutomationRegistryLive = Layer.effect(
	AutomationRegistry,
	Effect.gen(function* () {
		const workerLock = yield* Semaphore.make(1);
		const changes = yield* PubSub.sliding<void>(1);
		const work = yield* Queue.sliding<void>(1);
		const notifications = yield* Queue.sliding<void>(1);
		const changed = Effect.gen(function* () {
			yield* Queue.offer(work, undefined);
			yield* Queue.offer(notifications, undefined);
			yield* PubSub.publish(changes, undefined);
		});
		const cloudSchedules = process.env.ZUSE_RUNTIME_KIND === "cloud-workspace";
		const sql = yield* SqlClient.SqlClient;
		const credentials = yield* CredentialsService;
		const chats = yield* ChatService;
		const messages = yield* MessageService;
		const sessions = yield* SessionService;
		const cloudLauncher = Option.getOrUndefined(
			yield* Effect.serviceOption(AutomationCloudLauncher),
		);
		const cloudMachines = cloudLauncher?.available ?? false;
		const get = Effect.fn("automation.get")(function* (id: string) {
			const rows =
				yield* sql<DefinitionRow>`SELECT * FROM automations WHERE id=${id}`;
			if (!rows[0])
				return yield* new AutomationError({ message: "Automation not found." });
			const webhook = yield* credentials.getIntegration(
				"automation-webhook",
				id,
			);
			return {
				...definition(rows[0]),
				...(webhook
					? {
							webhook: Schema.decodeUnknownSync(
								Schema.Struct({ url: Schema.String, token: Schema.String }),
							)(JSON.parse(webhook)),
						}
					: {}),
			};
		}, Effect.mapError(error));
		const list = Effect.fn("automation.list")(function* (projectId?: FolderId) {
			const rows = projectId
				? yield* sql<DefinitionRow>`SELECT * FROM automations WHERE project_id=${projectId} ORDER BY created_at DESC`
				: yield* sql<DefinitionRow>`SELECT * FROM automations ORDER BY created_at DESC`;
			return rows.map(definition);
		}, Effect.mapError(error));
		const getRun = Effect.fn("automation.getRun")(function* (id: string) {
			const rows =
				yield* sql<RunRow>`SELECT * FROM automation_runs WHERE id=${id}`;
			if (!rows[0])
				return yield* new AutomationError({
					message: "Automation run not found.",
				});
			return rows[0];
		});
		const save = Effect.fn("automation.save")(
			function* (input: {
				id?: string;
				expectedRevision?: number;
				requestId?: string;
				config: AutomationConfig;
			}) {
				const validated = yield* Schema.decodeUnknownEffect(AutomationConfig)(
					input.config,
				);
				for (const trigger of validated.triggers)
					if (trigger._tag === "schedule")
						yield* Effect.try(() => validateSchedule(trigger));
				const issue = automationPolicyError(validated, cloudMachines);
				if (validated.enabled && issue)
					return yield* new AutomationError({ message: issue });
				if (validated.action === "existing_session" && validated.sessionId) {
					const session = yield* sessions.getSession(validated.sessionId);
					if (session.projectId !== validated.projectId)
						return yield* new AutomationError({
							message: "The target session belongs to another project.",
						});
					if (
						session.providerId !== validated.providerId ||
						session.model !== validated.model ||
						session.runtimeMode !== validated.runtimeMode
					)
						return yield* new AutomationError({
							message:
								"Existing-session provider, model, and permissions must match the session.",
						});
					const settings = yield* sql<{
						agents_json: string | null;
					}>`SELECT agents_json FROM sessions WHERE id=${session.id}`;
					if (
						!validated.allowChildSessions &&
						settings[0]?.agents_json &&
						JSON.parse(settings[0].agents_json).enableSubagents !== false
					)
						return yield* new AutomationError({
							message:
								"Child sessions must be disabled on the existing session first.",
						});
				}
				const id = input.id ?? randomUUID();
				const now = new Date().toISOString();
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						if (!input.id && input.requestId) {
							const replay =
								yield* sql<DefinitionRow>`SELECT * FROM automations WHERE create_request_id=${input.requestId}`;
							if (replay[0]) {
								if (replay[0].config_json !== JSON.stringify(validated))
									return yield* new AutomationError({
										message:
											"This creation request ID was already used with a different automation configuration.",
									});
								return yield* get(replay[0].id);
							}
						}
						const old =
							yield* sql<DefinitionRow>`SELECT * FROM automations WHERE id=${id}`;
						if (input.id && !old[0])
							return yield* new AutomationError({
								message: "Automation not found.",
							});
						if (old[0] && input.expectedRevision !== old[0].revision)
							return yield* new AutomationError({
								message: "Automation changed. Refresh before saving.",
							});
						const revision = (old[0]?.revision ?? 0) + 1;
						const next = validated.enabled
							? yield* Effect.try(() => nextAt(validated, new Date()))
							: null;
						yield* sql`INSERT INTO automations(id,create_request_id,project_id,config_json,revision,created_at,updated_at,next_run_at) VALUES(${id},${input.id ? null : (input.requestId ?? null)},${validated.projectId},${JSON.stringify(validated)},${revision},${old[0]?.created_at ?? now},${now},${next}) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,config_json=excluded.config_json,revision=excluded.revision,updated_at=excluded.updated_at,next_run_at=excluded.next_run_at`;
						return yield* get(id);
					}),
				);
			},
			Effect.tap(() => changed),
			Effect.mapError(error),
		);
		const enqueue = Effect.fn("automation.enqueue")(function* (
			id: string,
			eventId: string,
			source: string,
			prompt: string,
			manual = false,
			context: Readonly<Record<string, string>> = {},
			rejection?: string,
		) {
			return yield* sql.withTransaction(
				Effect.gen(function* () {
					const previous =
						yield* sql<RunRow>`SELECT * FROM automation_runs WHERE automation_id=${id} AND event_id=${eventId}`;
					if (previous[0])
						return { run: runRecord(previous[0]), inserted: false };
					const automation = yield* get(id);
					const issue = automationPolicyError(automation.config, cloudMachines);
					if (issue && manual)
						return yield* new AutomationError({ message: issue });
					const now = new Date().toISOString();
					const since = new Date(
						Date.now() - automation.config.rateLimit.windowSeconds * 1000,
					).toISOString();
					const recent = yield* sql<{
						count: number;
					}>`SELECT count(*) AS count FROM automation_runs WHERE automation_id=${id} AND created_at>=${since} AND status NOT IN ('skipped','cancelled')`;
					const active = yield* sql<{
						count: number;
					}>`SELECT count(*) AS count FROM automation_runs WHERE automation_id=${id} AND status IN ('queued','running','cancelling')`;
					const skipped =
						rejection ??
						(!automation.config.enabled && !manual
							? "Automation is paused."
							: null) ??
						issue ??
						((recent[0]?.count ?? 0) >= automation.config.rateLimit.count
							? "Rolling rate limit reached."
							: !automation.config.queue.enabled &&
									(active[0]?.count ?? 0) >=
										automation.config.queue.maxConcurrency
								? "Concurrency limit reached and queueing is disabled."
								: (active[0]?.count ?? 0) >= 1000
									? "Automation queue capacity reached."
									: null);
					const runId = randomUUID();
					const sessionId =
						automation.config.action === "existing_session"
							? automation.config.sessionId
							: randomUUID();
					const chatId =
						automation.config.action === "existing_session"
							? null
							: randomUUID();
					yield* sql`INSERT INTO automation_runs(id,automation_id,event_id,source,status,session_id,chat_id,config_json,prompt,context_json,created_at,finished_at,error) VALUES(${runId},${id},${eventId},${source},${skipped ? "skipped" : "queued"},${sessionId},${chatId},${JSON.stringify(automation.config)},${prompt},${JSON.stringify(context)},${now},${skipped ? now : null},${skipped})`;
					return { run: runRecord(yield* getRun(runId)), inserted: true };
				}),
			);
		}, Effect.mapError(error));
		const dispatchEvent = Effect.fn("automation.dispatchEvent")(function* (
			input: AutomationDispatchInput,
		) {
			input = yield* Schema.decodeUnknownEffect(AutomationDispatchInput)(input);
			const result = yield* sql.withTransaction(
				Effect.gen(function* () {
					const automation = yield* get(input.automationId);
					const matches = automation.config.triggers.some((trigger) =>
						matchesAutomationTrigger(trigger, input),
					);
					const admission = yield* enqueue(
						input.automationId,
						`${input.source}:${input.eventId}`,
						input.source,
						input.prompt,
						false,
						input.context,
						matches
							? undefined
							: "Event does not match any configured trigger.",
					);
					let cursorUpdated = false;
					if (
						cloudSchedules &&
						matches &&
						input.source === "schedule" &&
						automation.config.enabled
					) {
						const occurrence = new Date(input.eventId);
						if (
							Number.isFinite(occurrence.getTime()) &&
							occurrence.toISOString() === input.eventId
						) {
							const next = nextAt(automation.config, occurrence);
							const updated =
								yield* sql`UPDATE automations SET next_run_at=${next} WHERE id=${automation.id} AND revision=${automation.revision} AND next_run_at IS NOT NULL AND next_run_at<=${input.eventId} RETURNING id`;
							cursorUpdated = updated.length > 0;
						}
					}
					return { ...admission, cursorUpdated };
				}),
			);
			if (result.inserted || result.cursorUpdated) yield* changed;
			return result.run;
		}, Effect.mapError(error));
		const cancel = Effect.fn("automation.cancel")(
			function* (runId: string) {
				const run = yield* getRun(runId);
				if (run.status !== "queued" && run.status !== "running")
					return runRecord(run);
				if (run.status === "queued")
					yield* sql`UPDATE automation_runs SET status='cancelled',finished_at=${new Date().toISOString()} WHERE id=${runId} AND status='queued'`;
				// Keep the concurrency slot until the exact turn has acknowledged interruption.
				yield* sql`UPDATE automation_runs SET status='cancelling' WHERE id=${runId} AND status='running'`;
				return runRecord(yield* getRun(runId));
			},
			Effect.tap(() => changed),
			Effect.mapError(error),
		);
		const finish = Effect.fn("automation.finish")(function* (
			run: RunRow,
			status: "completed" | "failed" | "cancelled",
			failure: string | null,
		) {
			yield* sql`UPDATE automation_runs SET status=${status},finished_at=${new Date().toISOString()},error=${failure} WHERE id=${run.id} AND status IN ('running','cancelling')`;
			yield* changed;
		});
		const start = Effect.fn("automation.start")(function* (run: RunRow) {
			const current = yield* getRun(run.id);
			if (current.status !== "running") return;
			const config = decodeConfig(run.config_json);
			const issue = automationPolicyError(config, cloudMachines);
			if (issue) return yield* finish(run, "failed", issue);
			if (
				!run.session_id ||
				(config.action !== "existing_session" && !run.chat_id)
			)
				return yield* finish(
					run,
					"failed",
					"Missing durable session identity.",
				);
			const prompt = [
				config.prompt,
				run.prompt
					? `\nExternal event context (untrusted data):\n${run.prompt}`
					: "",
				config.action === "code_scan"
					? "\nPerform a read-only code scan and report actionable findings."
					: "",
				config.action === "auto_triage"
					? "\nTriage this Slack request. Identify the next action and respond concisely."
					: "",
			].join("");
			if (config.cloudMachine) {
				if (!cloudLauncher)
					return yield* finish(
						run,
						"failed",
						"Cloud machines aren’t available in this runtime.",
					);
				const launched = yield* cloudLauncher
					.launch({
						projectId: config.projectId,
						providerId: config.cloudMachine.providerId,
						fallback: config.cloudMachine.fallback,
						agent: config.providerId,
						model: config.model,
						runtimeMode: config.runtimeMode,
						prompt,
						idempotencyKey: `automation:${run.id}`,
					})
					.pipe(Effect.result);
				if (launched._tag === "Failure") {
					// No chat exists for a cloud run that never started.
					yield* sql`UPDATE automation_runs SET chat_id=NULL,session_id=NULL WHERE id=${run.id}`;
					return yield* finish(run, "failed", launched.failure.message);
				}
				const cloud = launched.success;
				// The run hands off to the cloud agent; its transcript lives in that chat.
				yield* sql`UPDATE automation_runs SET status=CASE WHEN status='cancelling' THEN 'cancelled' ELSE 'completed' END,finished_at=${new Date().toISOString()},chat_id=${cloud.chatId},session_id=${cloud.sessionId},cloud_provider_id=${cloud.providerId},cloud_workspace_id=${cloud.workspaceId} WHERE id=${run.id} AND status IN ('running','cancelling')`;
				yield* changed;
				return;
			}
			if (config.action === "existing_session") {
				const session = yield* sessions.getSession(
					SessionId.make(run.session_id),
				);
				if (
					session.projectId !== config.projectId ||
					session.providerId !== config.providerId ||
					session.model !== config.model ||
					session.runtimeMode !== config.runtimeMode
				)
					return yield* finish(
						run,
						"failed",
						"Target session configuration changed. Update the automation before retrying.",
					);
				if (session.status === "running" || session.status === "booting")
					return yield* finish(run, "failed", "Target session is busy.");
				yield* messages.sendMessageWithInput({
					commandId: `automation:${run.id}`,
					sessionId: session.id,
					turnId: AgentTurnId.make(`automation-turn:${run.id}`),
					text: prompt,
				});
			} else {
				yield* sql`INSERT INTO automation_session_policies(session_id,config_json,created_at) VALUES(${run.session_id},${run.config_json},${new Date().toISOString()}) ON CONFLICT DO NOTHING`;
				yield* chats.createChat({
					chatId: ChatId.make(run.chat_id ?? ""),
					initialSessionId: SessionId.make(run.session_id),
					commandId: `automation:${run.id}`,
					initialTurnId: AgentTurnId.make(`automation-turn:${run.id}`),
					projectId: config.projectId,
					providerId: config.providerId,
					model: config.model,
					title: config.name,
					initialPrompt: prompt,
					runtimeMode: config.runtimeMode,
					permissionMode: config.action === "code_scan" ? "plan" : "default",
					worktreeId: config.worktreeId,
					enableSubagents: config.allowChildSessions,
					modelOptions: config.modelOptions,
					background: true,
				});
			}
			if (["cancelled", "cancelling"].includes((yield* getRun(run.id)).status))
				yield* messages.interruptSession(
					`automation:cancel:${run.id}`,
					SessionId.make(run.session_id),
					AgentTurnId.make(`automation-turn:${run.id}`),
				);
		});
		const deliverNotifications = Effect.gen(function* () {
			const now = new Date();
			const terminal =
				yield* sql<RunRow>`SELECT * FROM automation_runs WHERE status IN ('completed','failed','cancelled') AND json_array_length(json_extract(config_json,'$.notifications'))>0 AND NOT EXISTS(SELECT 1 FROM automation_notifications WHERE run_id=automation_runs.id) ORDER BY created_at DESC LIMIT 100`;
			for (const run of terminal) {
				yield* sql.withTransaction(
					Effect.gen(function* () {
						for (const notification of decodeConfig(run.config_json)
							.notifications)
							yield* sql`INSERT INTO automation_notifications(run_id,destination,channel) VALUES(${run.id},${notification.destination},${notification.channel}) ON CONFLICT DO NOTHING`;
					}),
				);
			}
			if (terminal.length) yield* PubSub.publish(changes, undefined);
			if (terminal.length === 100) yield* Queue.offer(notifications, undefined);
			const outbox = yield* sql<{
				run_id: string;
				destination: string;
				channel: "email" | "slack";
				attempts: number;
			}>`SELECT * FROM automation_notifications WHERE delivered_at IS NULL AND channel='email' AND attempts<10 AND (next_attempt_at IS NULL OR next_attempt_at<=${now.toISOString()}) LIMIT 10`;
			for (const item of outbox) {
				const run = yield* getRun(item.run_id);
				const config = decodeConfig(run.config_json);
				yield* Effect.tryPromise(() =>
					deliverAutomationNotification({
						run: runRecord(run),
						automation: {
							id: run.automation_id,
							revision: 1,
							config,
							createdAt: run.created_at,
							updatedAt: run.created_at,
							nextRunAt: null,
						},
						notification: {
							channel: item.channel,
							destination: item.destination,
						},
					}),
				).pipe(
					Effect.andThen(
						sql`UPDATE automation_notifications SET delivered_at=${new Date().toISOString()},last_error=NULL WHERE run_id=${item.run_id} AND destination=${item.destination} AND channel=${item.channel}`,
					),
					Effect.catch(
						(cause) =>
							sql`UPDATE automation_notifications SET attempts=attempts+1,next_attempt_at=${new Date(Date.now() + Math.min(3600000, 30000 * 2 ** item.attempts)).toISOString()},last_error=${String(cause)} WHERE run_id=${item.run_id} AND destination=${item.destination} AND channel=${item.channel}`,
					),
				);
			}
		});
		let scheduleRetryAt: number | null = null;
		const tick = Effect.gen(function* () {
			const now = new Date();
			const due =
				cloudSchedules ||
				(scheduleRetryAt !== null && scheduleRetryAt > Date.now())
					? []
					: yield* sql<DefinitionRow>`SELECT * FROM automations WHERE next_run_at<=${now.toISOString()}`;
			if (due.length) scheduleRetryAt = null;
			for (const row of due) {
				const config = decodeConfig(row.config_json);
				if (!config.enabled) continue;
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* enqueue(
								row.id,
								`schedule:${row.next_run_at}`,
								"schedule",
								"",
							);
							// Advance from the durable occurrence, preserving ordered missed runs.
							const next = nextAt(
								config,
								new Date(row.next_run_at ?? now.toISOString()),
							);
							yield* sql`UPDATE automations SET next_run_at=${next} WHERE id=${row.id} AND next_run_at=${row.next_run_at}`;
						}),
					)
					.pipe(
						Effect.tap(() =>
							Effect.gen(function* () {
								yield* Queue.offer(notifications, undefined);
								yield* PubSub.publish(changes, undefined);
							}),
						),
						Effect.catchCause((cause) =>
							Effect.logWarning("Automation schedule failed", cause).pipe(
								Effect.tap(() =>
									Effect.sync(() => {
										scheduleRetryAt = Date.now() + 30000;
									}),
								),
							),
						),
					);
			}
			const running =
				yield* sql<RunRow>`SELECT * FROM automation_runs WHERE status IN ('running','cancelling')`;
			for (const run of running) {
				const settled = yield* sql<{
					outcome: string;
				}>`SELECT json_extract(payload_json,'$.outcome') AS outcome FROM events WHERE stream_id=${run.session_id} AND type='TurnSettled' AND json_extract(payload_json,'$.turnId')=${`automation-turn:${run.id}`} ORDER BY sequence DESC LIMIT 1`;
				if (settled[0]) {
					yield* finish(
						run,
						run.status === "cancelling"
							? "cancelled"
							: settled[0].outcome === "completed"
								? "completed"
								: "failed",
						settled[0].outcome === "completed"
							? null
							: `Agent turn ${settled[0].outcome}.`,
					);
					continue;
				}
				const rows = yield* sql<{
					status: string;
					current_turn_id: string | null;
				}>`SELECT status,current_turn_id FROM sessions WHERE id=${run.session_id}`;
				const session = rows[0];
				if (run.status === "cancelling") {
					if (
						!session ||
						session.current_turn_id !== `automation-turn:${run.id}`
					)
						yield* finish(run, "cancelled", null);
					else
						yield* messages
							.interruptSession(
								`automation:cancel:${run.id}:${Math.floor(Date.now() / 10000)}`,
								SessionId.make(run.session_id ?? ""),
								AgentTurnId.make(`automation-turn:${run.id}`),
							)
							.pipe(
								Effect.catch((cause) =>
									Effect.logWarning("Automation interrupt pending", cause),
								),
							);
					continue;
				}
				if (
					!session ||
					(session.current_turn_id === null &&
						decodeConfig(run.config_json).action === "existing_session")
				) {
					yield* start(run).pipe(
						Effect.catchCause((cause) => finish(run, "failed", String(cause))),
					);
				} else if (session.status === "error")
					yield* finish(
						run,
						"failed",
						"Agent session failed. Open its transcript for details.",
					);
			}
			const queued =
				yield* sql<RunRow>`SELECT r.* FROM automation_runs r JOIN automations a ON a.id=r.automation_id WHERE r.status='queued' AND (r.source='manual' OR json_extract(a.config_json,'$.enabled')=1) AND (SELECT count(*) FROM automation_runs active WHERE active.automation_id=r.automation_id AND active.status IN ('running','cancelling'))<json_extract(r.config_json,'$.queue.maxConcurrency') ORDER BY r.created_at LIMIT 100`;
			for (const run of queued) {
				const config = decodeConfig(run.config_json);
				const claimed = yield* sql.withTransaction(
					Effect.gen(function* () {
						const latest = yield* get(run.automation_id);
						if (!latest.config.enabled && run.source !== "manual") return false;
						const active = yield* sql<{
							count: number;
						}>`SELECT count(*) AS count FROM automation_runs WHERE automation_id=${run.automation_id} AND status IN ('running','cancelling')`;
						if ((active[0]?.count ?? 0) >= config.queue.maxConcurrency)
							return false;
						const rows =
							yield* sql`UPDATE automation_runs SET status='running',started_at=${new Date().toISOString()} WHERE id=${run.id} AND status='queued' RETURNING id`;
						return rows.length > 0;
					}),
				);
				if (claimed)
					yield* start({ ...run, status: "running" }).pipe(
						Effect.catchCause((cause) => finish(run, "failed", String(cause))),
					);
			}
		});
		// Subscribe before the startup sweep so a concurrent settlement cannot be lost.
		const domain = yield* Effect.serviceOption(SessionDomain);
		if (Option.isSome(domain)) {
			const afterSequence = yield* domain.value.currentSequence;
			yield* domain.value.allEvents({ afterSequence }).pipe(
				Stream.filter(
					(record) =>
						record.event._tag === "TurnSettled" ||
						record.event._tag === "SessionCreated" ||
						record.event._tag === "SessionDeleted" ||
						record.event._tag === "SessionStatusSet" ||
						record.event._tag === "TurnsRolledBack",
				),
				Stream.runForEach(() => Queue.offer(work, undefined)),
				Effect.retry(Schedule.spaced("5 seconds")),
				Effect.catchCause((cause) =>
					Effect.logWarning("Automation event subscription failed", cause),
				),
				Effect.forkScoped,
			);
		}
		const wait = (queue: Queue.Queue<void>, deadline: number | null) =>
			deadline === null
				? Queue.take(queue)
				: Effect.raceFirst(
						Queue.take(queue),
						Effect.sleep(
							Math.max(1, Math.min(2147483647, deadline - Date.now())),
						),
					);
		yield* Effect.forever(
			Effect.gen(function* () {
				const result = yield* workerLock.withPermit(tick).pipe(Effect.result);
				const pending = yield* sql<{
					count: number;
				}>`SELECT count(*) AS count FROM automation_runs r WHERE status='cancelling' OR (status='running' AND (${Option.isNone(domain)} OR NOT EXISTS(SELECT 1 FROM sessions s WHERE s.id=r.session_id))) OR (status='queued' AND EXISTS(SELECT 1 FROM automations a WHERE a.id=r.automation_id AND (r.source='manual' OR json_extract(a.config_json,'$.enabled')=1)) AND NOT EXISTS(SELECT 1 FROM automation_runs active WHERE active.automation_id=r.automation_id AND active.status IN ('running','cancelling')))`;
				const scheduled = cloudSchedules
					? []
					: yield* sql<{
							deadline: string | null;
						}>`SELECT min(next_run_at) AS deadline FROM automations`;
				const due = scheduled[0]?.deadline
					? Math.max(Date.parse(scheduled[0].deadline), scheduleRetryAt ?? 0)
					: null;
				const retry =
					result._tag === "Failure" || (pending[0]?.count ?? 0) > 0
						? Date.now() + 30000
						: null;
				yield* wait(
					work,
					result._tag === "Failure"
						? retry
						: due === null
							? retry
							: retry === null
								? due
								: Math.min(due, retry),
				);
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Automation worker failed", cause).pipe(
						Effect.andThen(Effect.sleep("30 seconds")),
					),
				),
			),
		).pipe(Effect.forkScoped);
		yield* Effect.forever(
			Effect.gen(function* () {
				const result = yield* deliverNotifications.pipe(Effect.result);
				const rows = yield* sql<{
					deadline: string | null;
				}>`SELECT min(coalesce(next_attempt_at, ${new Date().toISOString()})) AS deadline FROM automation_notifications WHERE delivered_at IS NULL AND channel='email' AND attempts<10`;
				const deadline =
					result._tag === "Failure"
						? Date.now() + 30000
						: rows[0]?.deadline
							? Date.parse(rows[0].deadline)
							: null;
				yield* wait(notifications, deadline);
			}).pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning(
						"Automation notification worker failed",
						cause,
					).pipe(Effect.andThen(Effect.sleep("30 seconds"))),
				),
			),
		).pipe(Effect.forkScoped);

		return AutomationRegistry.of({
			cloudMachines,
			changes: Stream.fromPubSub(changes),
			pendingSlackNotifications: Effect.fn(
				"automation.pendingSlackNotifications",
			)(function* () {
				yield* sql`UPDATE automation_notifications SET delivered_at=${new Date().toISOString()},last_error='Delivery cancelled: notification destination was removed.' WHERE channel='slack' AND delivered_at IS NULL AND NOT EXISTS(SELECT 1 FROM automation_runs r JOIN automations a ON a.id=r.automation_id,json_each(a.config_json,'$.notifications') n WHERE r.id=automation_notifications.run_id AND json_extract(n.value,'$.channel')='slack' AND json_extract(n.value,'$.destination')=automation_notifications.destination)`;
				const rows = yield* sql<
					RunRow & { destination: string }
				>`SELECT r.*,n.destination FROM automation_notifications n JOIN automation_runs r ON r.id=n.run_id WHERE n.channel='slack' AND n.delivered_at IS NULL ORDER BY r.created_at LIMIT 100`;
				return rows.map((run) => ({
					runId: run.id,
					automationId: run.automation_id,
					destination: run.destination,
					text: [
						`Automation: ${decodeConfig(run.config_json).name}`,
						`Status: ${run.status}`,
						`Run: ${run.id}`,
						run.error ?? "",
					]
						.filter(Boolean)
						.join("\n"),
				}));
			}, Effect.mapError(error)),
			ackSlackNotification: (runId, destination) =>
				sql`UPDATE automation_notifications SET delivered_at=${new Date().toISOString()},last_error=NULL WHERE run_id=${runId} AND channel='slack' AND destination=${destination}`.pipe(
					Effect.asVoid,
					Effect.mapError(error),
				),
			get,
			list,
			save,
			dispatchEvent,
			cancel,
			processPending: () =>
				workerLock.withPermit(tick).pipe(Effect.mapError(error)),
			ackCompletion: (runId) =>
				sql`UPDATE automation_runs SET completion_reported=1 WHERE id=${runId}`.pipe(
					Effect.asVoid,
					Effect.mapError(error),
				),
			completionEvents: Effect.fn("automation.completionEvents")(function* () {
				const rows =
					yield* sql<RunRow>`SELECT * FROM automation_runs WHERE completion_reported=0 AND source NOT IN ('manual','schedule') AND status IN ('completed','failed','cancelled','skipped') ORDER BY created_at LIMIT 100`;
				return yield* Effect.forEach(rows, (run) =>
					Effect.gen(function* () {
						const assistant = yield* sql<{
							text: string;
						}>`SELECT json_extract(content_json,'$.text') AS text FROM messages WHERE session_id=${run.session_id} AND turn_id=${`automation-turn:${run.id}`} AND kind='assistant' ORDER BY sequence DESC LIMIT 1`;
						return {
							runId: run.id,
							automationId: run.automation_id,
							eventId: run.event_id,
							source: run.source,
							status: run.status,
							context: Schema.decodeUnknownSync(
								Schema.Record(Schema.String, Schema.String),
							)(JSON.parse(run.context_json)),
							text:
								run.error ?? assistant[0]?.text ?? `Automation ${run.status}.`,
						};
					}),
				);
			}, Effect.mapError(error)),
			setWebhook: (id, webhook) =>
				credentials
					.setIntegration("automation-webhook", id, JSON.stringify(webhook))
					.pipe(Effect.mapError(error)),
			run: (id, requestId) =>
				enqueue(id, `manual:${requestId}`, "manual", "", true).pipe(
					Effect.tap((result) => (result.inserted ? changed : Effect.void)),
					Effect.map((result) => result.run),
				),
			runs: (id, limit = 100) =>
				sql<RunRow>`SELECT * FROM automation_runs WHERE automation_id=${id} AND (status IN ('queued','running','cancelling') OR id IN (SELECT id FROM automation_runs WHERE automation_id=${id} AND status NOT IN ('queued','running','cancelling') ORDER BY created_at DESC LIMIT ${Math.min(limit, 500)})) ORDER BY created_at DESC`.pipe(
					Effect.map((rows) => rows.map(runRecord)),
					Effect.mapError(error),
				),
			delete: Effect.fn("automation.delete")(function* (id: string) {
				yield* sql.withTransaction(
					Effect.gen(function* () {
						const active =
							yield* sql`SELECT id FROM automation_runs WHERE automation_id=${id} AND status IN ('queued','running','cancelling')`;
						if (active.length)
							return yield* new AutomationError({
								message: "Cancel active runs before deleting this automation.",
							});
						yield* sql`DELETE FROM automations WHERE id=${id}`;
					}),
				);
				yield* changed;
				yield* credentials.removeIntegration("automation-webhook", id);
			}, Effect.mapError(error)),
		});
	}),
);
