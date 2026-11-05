import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AutomationConfig,
	AutomationError,
	FolderId,
} from "@zuse/contracts";
import type { StoredEvent } from "@zuse/domain/engine/dispatch";
import { SessionDomain } from "@zuse/domain/engine/session-domain";
import { layer as sqliteLayer } from "@zuse/sqlite";
import { Effect, Layer, ManagedRuntime, PubSub, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
	AutomationAgentRouter,
	AutomationAgentRouterLive,
	AutomationAgentToolsLive,
	automationAgentOperation,
	makeAutomationAgentRouterLayer,
} from "../../src/automation/agent-tools.ts";
import {
	AutomationCloudLauncher,
	type AutomationCloudLauncherShape,
} from "../../src/automation/cloud-launcher.ts";
import { AutomationRegistryLive } from "../../src/automation/layer.ts";
import { AutomationRegistry } from "../../src/automation/registry-service.ts";
import {
	ChatService,
	MessageService,
	SessionService,
} from "../../src/conversation/services/conversation-services.ts";
import { Migration0093ProjectAutomations } from "../../src/persistence/migrations/0093_project_automations.ts";
import { Migration0094AutomationCloudRuns } from "../../src/persistence/migrations/0094_automation_cloud_runs.ts";
import { CredentialsService } from "../../src/provider/services/credentials-service.ts";

const config: AutomationConfig = {
	projectId: FolderId.make("project"),
	name: "Daily review",
	description: "",
	enabled: true,
	triggers: [{ _tag: "manual" }],
	action: "new_session",
	sessionId: null,
	prompt: "Review the repository",
	providerId: "claude",
	model: "test-model",
	modelOptions: {},
	runtimeMode: "approval-required",
	runAs: "owner",
	worktreeId: null,
	environment: "local",
	mcpServerIds: [],
	allowChildSessions: false,
	network: { enabled: true, allowedDomains: [] },
	metadata: {},
	spendLimitUsd: null,
	rateLimit: { count: 10, windowSeconds: 3600 },
	queue: { enabled: true, maxConcurrency: 1 },
	notifications: [],
};
const unexpected = <T>(implemented: Partial<T>): T =>
	new Proxy(implemented, {
		get(target, key) {
			return (
				Reflect.get(target, key) ??
				(() => Effect.die(`Unexpected service method: ${String(key)}`))
			);
		},
	}) as T;
const fixture = async (
	filename = ":memory:",
	launcher?: AutomationCloudLauncherShape,
) => {
	const events = await Effect.runPromise(PubSub.unbounded<StoredEvent>());
	const sqlLayer = sqliteLayer({ filename });
	const schema = Layer.effectDiscard(
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const existing =
				yield* sql`SELECT name FROM sqlite_master WHERE type='table' AND name='automations'`;
			if (existing.length) return;
			yield* sql`CREATE TABLE messages(session_id TEXT,turn_id TEXT,kind TEXT,content_json TEXT,sequence INTEGER)`;
			yield* sql`CREATE TABLE projects(id TEXT PRIMARY KEY)`;
			yield* sql`INSERT INTO projects(id) VALUES('project')`;
			yield* sql`CREATE TABLE sessions(id TEXT PRIMARY KEY,status TEXT,current_turn_id TEXT)`;
			yield* sql`CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,stream_id TEXT,type TEXT,payload_json TEXT)`;
			yield* Migration0093ProjectAutomations;
			yield* Migration0094AutomationCloudRuns;
		}),
	).pipe(Layer.provide(sqlLayer));
	const secrets = new Map<string, string>();
	const creates: string[] = [];
	const dependencies = Layer.mergeAll(
		Layer.succeed(
			SessionDomain,
			unexpected<SessionDomain["Service"]>({
				currentSequence: Effect.succeed(0),
				allEvents: () => Stream.fromPubSub(events),
			}),
		),
		sqlLayer,
		schema,
		Layer.succeed(
			CredentialsService,
			unexpected<CredentialsService["Service"]>({
				getIntegration: (_, id) => Effect.succeed(secrets.get(id) ?? null),
				setIntegration: (_, id, value) =>
					Effect.sync(() => {
						secrets.set(id, value);
					}),
				removeIntegration: (_, id) =>
					Effect.sync(() => {
						secrets.delete(id);
					}),
			}),
		),
		Layer.succeed(
			ChatService,
			unexpected<ChatService["Service"]>({
				createChat: (input) =>
					Effect.gen(function* () {
						creates.push(String(input.initialSessionId));
						const sql = yield* SqlClient.SqlClient;
						yield* sql`INSERT INTO sessions(id,status,current_turn_id) VALUES(${input.initialSessionId ?? "missing"},'running',${input.initialTurnId ?? "missing"}) ON CONFLICT DO NOTHING`;
						return {
							chat: { id: input.chatId },
							initialSession: { id: input.initialSessionId },
							initialMessage: null,
						} as Awaited<
							Effect.Success<ReturnType<ChatService["Service"]["createChat"]>>
						>;
					}).pipe(Effect.provide(sqlLayer), Effect.orDie),
			}),
		),
		Layer.succeed(
			MessageService,
			unexpected<MessageService["Service"]>({
				listMessages: () => Effect.succeed([]),
				interruptSession: () =>
					Effect.succeed({
						_tag: "not-active",
						reason: "no-active-turn",
						expectedTurnId: null,
						actualTurnId: null,
					}),
			}),
		),
		Layer.succeed(SessionService, unexpected<SessionService["Service"]>({})),
		...(launcher ? [Layer.succeed(AutomationCloudLauncher, launcher)] : []),
	);
	const runtime = ManagedRuntime.make(
		AutomationRegistryLive.pipe(Layer.provideMerge(dependencies)),
	);
	const service = await runtime.runPromise(AutomationRegistry);
	return { runtime, service, creates, events };
};
describe("durable automation engine", () => {
	it("starts queued work on mutation and observes persisted terminal events without manual sweeps", async () => {
		const { runtime, service, creates, events } = await fixture();
		try {
			const automation = await runtime.runPromise(service.save({ config }));
			const run = await runtime.runPromise(
				service.run(automation.id, "event-driven"),
			);
			await expect.poll(() => creates.length, { timeout: 1000 }).toBe(1);
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO events(stream_id,type,payload_json) VALUES(${run.sessionId},'TurnSettled',${JSON.stringify({ turnId: `automation-turn:${run.id}`, outcome: "completed" })})`;
					yield* PubSub.publish(
						events,
						unexpected<StoredEvent>({
							event: unexpected<StoredEvent["event"]>({ _tag: "TurnSettled" }),
						}),
					);
				}),
			);
			await expect
				.poll(
					async () =>
						(await runtime.runPromise(service.runs(automation.id)))[0]?.status,
					{ timeout: 1000 },
				)
				.toBe("completed");
		} finally {
			await runtime.dispose();
		}
	});

	it("makes concurrent creation retries idempotent and rejects changed payloads", async () => {
		const { runtime, service } = await fixture();
		try {
			const [first, second] = await Promise.all([
				runtime.runPromise(service.save({ config, requestId: "create-once" })),
				runtime.runPromise(service.save({ config, requestId: "create-once" })),
			]);
			expect(first.id).toBe(second.id);
			expect(await runtime.runPromise(service.list())).toHaveLength(1);
			await expect(
				runtime.runPromise(
					service.save({
						config: { ...config, name: "Different" },
						requestId: "create-once",
					}),
				),
			).rejects.toThrow("different");
		} finally {
			await runtime.dispose();
		}
	});

	it("deduplicates concurrent requests and honors concurrency across queued runs", async () => {
		const { runtime, service, creates } = await fixture();
		try {
			const automation = await runtime.runPromise(service.save({ config }));
			const [a, b] = await Promise.all([
				runtime.runPromise(service.run(automation.id, "same")),
				runtime.runPromise(service.run(automation.id, "same")),
			]);
			expect(a.id).toBe(b.id);
			const second = await runtime.runPromise(
				service.run(automation.id, "second"),
			);
			await runtime.runPromise(service.processPending());
			expect(creates).toHaveLength(1);
			const runs = await runtime.runPromise(service.runs(automation.id));
			expect(runs.find((run) => run.id === second.id)?.status).toBe("queued");
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO events(stream_id,type,payload_json) VALUES(${a.sessionId},'TurnSettled',${JSON.stringify({ turnId: `automation-turn:${a.id}`, outcome: "completed" })})`;
				}),
			);
			await runtime.runPromise(service.processPending());
			expect(creates).toHaveLength(2);
			expect(
				(await runtime.runPromise(service.runs(automation.id))).find(
					(run) => run.id === a.id,
				)?.status,
			).toBe("completed");
		} finally {
			await runtime.dispose();
		}
	});
	it("persists rate-limit skips and rejects stale edits without changing the definition", async () => {
		const { runtime, service } = await fixture();
		try {
			const automation = await runtime.runPromise(
				service.save({
					config: { ...config, rateLimit: { count: 1, windowSeconds: 3600 } },
				}),
			);
			await runtime.runPromise(service.run(automation.id, "first"));
			const rejected = await runtime.runPromise(
				service.run(automation.id, "second"),
			);
			expect(rejected.status).toBe("skipped");
			expect(rejected.error).toContain("rate limit");
			await expect(
				runtime.runPromise(
					service.save({
						id: automation.id,
						expectedRevision: 99,
						config: { ...config, name: "Lost update" },
					}),
				),
			).rejects.toThrow("changed");
			expect(
				(await runtime.runPromise(service.get(automation.id))).config.name,
			).toBe(config.name);
		} finally {
			await runtime.dispose();
		}
	});
	it("fails closed for unenforceable restrictions and validates external source before enqueue", async () => {
		const { runtime, service } = await fixture();
		try {
			await expect(
				runtime.runPromise(
					service.save({
						config: {
							...config,
							network: { enabled: false, allowedDomains: [] },
						},
					}),
				),
			).rejects.toThrow("network");
			const automation = await runtime.runPromise(service.save({ config }));
			const rejected = await runtime.runPromise(
				service.dispatchEvent({
					automationId: automation.id,
					eventId: "delivery",
					source: "slack",
					prompt: "hello",
					context: {},
				}),
			);
			expect(rejected.status).toBe("skipped");
			expect(rejected.error).toContain("match");
			expect(
				await runtime.runPromise(service.runs(automation.id)),
			).toHaveLength(1);
		} finally {
			await runtime.dispose();
		}
	});
});

describe("automation recovery and lifecycle", () => {
	it("recovers claimed work with stable identity after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "zuse-automation-test-"));
		const filename = join(directory, "runtime.db");
		let first = await fixture(filename);
		try {
			const automation = await first.runtime.runPromise(
				first.service.save({ config }),
			);
			const run = await first.runtime.runPromise(
				first.service.run(automation.id, "restart"),
			);
			await first.runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`UPDATE automation_runs SET status='running' WHERE id=${run.id}`;
				}),
			);
			await first.runtime.dispose();
			first = await fixture(filename);
			await first.runtime.runPromise(first.service.processPending());
			expect(first.creates).toEqual([run.sessionId]);
			await first.runtime.runPromise(first.service.processPending());
			expect(first.creates).toHaveLength(1);
			expect(
				(
					await first.runtime.runPromise(
						first.service.run(automation.id, "restart"),
					)
				).id,
			).toBe(run.id);
		} finally {
			await first.runtime.dispose();
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("holds paused event work and preserves concurrency while cancellation is pending", async () => {
		const { runtime, service, creates } = await fixture();
		try {
			const automation = await runtime.runPromise(
				service.save({
					config: { ...config, triggers: [{ _tag: "webhook" }] },
				}),
			);
			const event = await runtime.runPromise(
				service.dispatchEvent({
					automationId: automation.id,
					eventId: "e",
					source: "webhook",
					prompt: "context",
					context: {},
				}),
			);
			const paused = await runtime.runPromise(
				service.save({
					id: automation.id,
					expectedRevision: automation.revision,
					config: { ...automation.config, enabled: false },
				}),
			);
			await runtime.runPromise(service.processPending());
			expect(creates).toHaveLength(0);
			await runtime.runPromise(
				service.save({
					id: automation.id,
					expectedRevision: paused.revision,
					config: automation.config,
				}),
			);
			await runtime.runPromise(service.processPending());
			expect((await runtime.runPromise(service.cancel(event.id))).status).toBe(
				"cancelling",
			);
			const next = await runtime.runPromise(service.run(automation.id, "next"));
			await runtime.runPromise(service.processPending());
			expect(creates).toHaveLength(1);
			expect(
				(await runtime.runPromise(service.runs(automation.id))).find(
					(run) => run.id === next.id,
				)?.status,
			).toBe("queued");
			await runtime.runPromise(
				Effect.gen(function* () {
					const sql = yield* SqlClient.SqlClient;
					yield* sql`INSERT INTO events(stream_id,type,payload_json) VALUES(${event.sessionId},'TurnSettled',${JSON.stringify({ turnId: `automation-turn:${event.id}`, outcome: "interrupted" })})`;
				}),
			);
			await runtime.runPromise(service.processPending());
			expect(creates).toHaveLength(2);
			expect(
				(await runtime.runPromise(service.runs(automation.id))).find(
					(run) => run.id === event.id,
				)?.status,
			).toBe("cancelled");
		} finally {
			await runtime.dispose();
		}
	});
});

it("retains immutable spending policy after definition deletion until the session is deleted", async () => {
	const { runtime, service } = await fixture();
	try {
		const automation = await runtime.runPromise(
			service.save({
				config: {
					...config,
					spendLimitUsd: 2,
					mcpServerIds: [],
				},
			}),
		);
		const run = await runtime.runPromise(service.run(automation.id, "policy"));
		await runtime.runPromise(service.processPending());
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`INSERT INTO events(stream_id,type,payload_json) VALUES(${run.sessionId},'TurnSettled',${JSON.stringify({ turnId: `automation-turn:${run.id}`, outcome: "completed" })})`;
			}),
		);
		await runtime.runPromise(service.processPending());
		await runtime.runPromise(service.delete(automation.id));
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				const policies = yield* sql<{
					config_json: string;
				}>`SELECT config_json FROM automation_session_policies WHERE session_id=${run.sessionId}`;
				expect(JSON.parse(policies[0]?.config_json ?? "{}")).toMatchObject({
					spendLimitUsd: 2,
					mcpServerIds: [],
				});
				yield* sql`DELETE FROM sessions WHERE id=${run.sessionId}`;
				expect(
					yield* sql`SELECT * FROM automation_session_policies`,
				).toHaveLength(0);
			}),
		);
	} finally {
		await runtime.dispose();
	}
});

it("replays missed schedule occurrences in order from the durable cursor", async () => {
	const { runtime, service } = await fixture();
	try {
		const automation = await runtime.runPromise(
			service.save({
				config: {
					...config,
					triggers: [{ _tag: "schedule", cron: "0 * * * *", timezone: "UTC" }],
				},
			}),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE automations SET next_run_at='2020-01-01T00:00:00.000Z' WHERE id=${automation.id}`;
			}),
		);
		await runtime.runPromise(service.processPending());
		await runtime.runPromise(service.processPending());
		expect(
			(await runtime.runPromise(service.get(automation.id))).nextRunAt,
		).toBe("2020-01-01T02:00:00.000Z");
		expect(
			(await runtime.runPromise(service.runs(automation.id)))
				.map((run) => run.eventId)
				.sort(),
		).toEqual([
			"schedule:2020-01-01T00:00:00.000Z",
			"schedule:2020-01-01T01:00:00.000Z",
		]);
	} finally {
		await runtime.dispose();
	}
});

describe("cloud machine automations", () => {
	const cloudConfig: AutomationConfig = {
		...config,
		allowChildSessions: true,
		cloudMachine: { providerId: "e2b", fallback: true },
	};
	it("starts each run as a cloud agent and records where it ran", async () => {
		const launches: string[] = [];
		const { runtime, service, creates } = await fixture(":memory:", {
			available: true,
			launch: (input) =>
				Effect.sync(() => {
					launches.push(`${input.providerId}:${input.idempotencyKey}`);
					return {
						providerId: "box",
						workspaceId: "ws-1",
						chatId: "cloud-chat",
						sessionId: "cloud-session",
					};
				}),
		});
		try {
			const automation = await runtime.runPromise(
				service.save({ config: cloudConfig }),
			);
			const run = await runtime.runPromise(service.run(automation.id, "go"));
			await runtime.runPromise(service.processPending());
			const [recorded] = await runtime.runPromise(service.runs(automation.id));
			expect(launches).toEqual([`e2b:automation:${run.id}`]);
			expect(creates).toHaveLength(0);
			expect(recorded).toMatchObject({
				status: "completed",
				chatId: "cloud-chat",
				cloudProviderId: "box",
				cloudWorkspaceId: "ws-1",
			});
		} finally {
			await runtime.dispose();
		}
	});
	it("fails the run with the launch reason instead of running locally", async () => {
		const { runtime, service, creates } = await fixture(":memory:", {
			available: true,
			launch: () =>
				Effect.fail(
					new AutomationError({ message: "E2B is unavailable right now." }),
				),
		});
		try {
			const automation = await runtime.runPromise(
				service.save({ config: cloudConfig }),
			);
			await runtime.runPromise(service.run(automation.id, "go"));
			await runtime.runPromise(service.processPending());
			const [recorded] = await runtime.runPromise(service.runs(automation.id));
			expect(recorded?.status).toBe("failed");
			expect(recorded?.error).toBe("E2B is unavailable right now.");
			expect(recorded?.chatId).toBeNull();
			expect(creates).toHaveLength(0);
		} finally {
			await runtime.dispose();
		}
	});
	it("refuses to enable cloud machines where the runtime cannot start them", async () => {
		const { runtime, service } = await fixture();
		try {
			await expect(
				runtime.runPromise(service.save({ config: cloudConfig })),
			).rejects.toThrow("Cloud machines");
			expect(
				(
					await runtime.runPromise(
						service.save({ config: { ...cloudConfig, enabled: false } }),
					)
				).config.cloudMachine,
			).toEqual({ providerId: "e2b", fallback: true });
		} finally {
			await runtime.dispose();
		}
	});
});

it("wakes a local one-time schedule at its deadline without manual sweeps", async () => {
	const { runtime, service, creates } = await fixture();
	try {
		const onceAt = new Date(Date.now() + 150).toISOString();
		const automation = await runtime.runPromise(
			service.save({
				config: {
					...config,
					triggers: [
						{ _tag: "schedule", cron: "0 * * * *", timezone: "UTC", onceAt },
					],
				},
			}),
		);
		await expect.poll(() => creates.length, { timeout: 1500 }).toBe(1);
		const runs = await runtime.runPromise(service.runs(automation.id));
		expect(runs[0]?.eventId).toBe(`schedule:${onceAt}`);
		expect(
			(await runtime.runPromise(service.get(automation.id))).nextRunAt,
		).toBeNull();
	} finally {
		await runtime.dispose();
	}
});

it("leaves cloud schedule delivery exclusively to the control plane", async () => {
	const previous = process.env.ZUSE_RUNTIME_KIND;
	process.env.ZUSE_RUNTIME_KIND = "cloud-workspace";
	const { runtime, service, creates } = await fixture();
	try {
		const automation = await runtime.runPromise(
			service.save({
				config: {
					...config,
					environment: "cloud",
					triggers: [{ _tag: "schedule", cron: "0 * * * *", timezone: "UTC" }],
				},
			}),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE automations SET next_run_at='2020-01-01T00:00:00.000Z' WHERE id=${automation.id}`;
			}),
		);
		await runtime.runPromise(service.processPending());
		expect(creates).toEqual([]);
		expect(await runtime.runPromise(service.runs(automation.id))).toEqual([]);
		const event = {
			automationId: automation.id,
			source: "schedule" as const,
			eventId: "2020-01-01T00:00:00.000Z",
			prompt: "",
			context: {},
		};
		await runtime.runPromise(service.dispatchEvent(event));
		expect(
			(await runtime.runPromise(service.get(automation.id))).nextRunAt,
		).toBe("2020-01-01T01:00:00.000Z");
		await runtime.runPromise(service.dispatchEvent(event));
		expect(
			(await runtime.runPromise(service.get(automation.id))).nextRunAt,
		).toBe("2020-01-01T01:00:00.000Z");
		const onceAt = new Date(Date.now() + 3600000).toISOString();
		const once = await runtime.runPromise(
			service.save({
				config: {
					...config,
					environment: "cloud",
					triggers: [
						{ _tag: "schedule", cron: "0 * * * *", timezone: "UTC", onceAt },
					],
				},
			}),
		);
		const onceEvent = { ...event, automationId: once.id, eventId: onceAt };
		await runtime.runPromise(service.dispatchEvent(onceEvent));
		await runtime.runPromise(service.dispatchEvent(onceEvent));
		expect(
			(await runtime.runPromise(service.get(once.id))).nextRunAt,
		).toBeNull();
	} finally {
		await runtime.dispose();
		if (previous === undefined) delete process.env.ZUSE_RUNTIME_KIND;
		else process.env.ZUSE_RUNTIME_KIND = previous;
	}
});

it("settles failed sessions when recovery emits a status change without TurnSettled", async () => {
	const { runtime, service, creates, events } = await fixture();
	try {
		const automation = await runtime.runPromise(service.save({ config }));
		const run = await runtime.runPromise(
			service.run(automation.id, "recovery-error"),
		);
		await expect.poll(() => creates.length, { timeout: 1000 }).toBe(1);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE sessions SET status='error' WHERE id=${run.sessionId}`;
				yield* PubSub.publish(
					events,
					unexpected<StoredEvent>({
						event: unexpected<StoredEvent["event"]>({
							_tag: "SessionStatusSet",
						}),
					}),
				);
			}),
		);
		await expect
			.poll(
				async () =>
					(await runtime.runPromise(service.runs(automation.id)))[0]?.status,
				{ timeout: 1000 },
			)
			.toBe("failed");
	} finally {
		await runtime.dispose();
	}
});

describe("native agent automation creation", () => {
	it("persists a paused definition in the same registry as the UI and deduplicates retries", async () => {
		const { runtime, service } = await fixture();
		try {
			const input = {
				configJson: JSON.stringify({ ...config, enabled: false }),
				requestId: "native-create-1",
			};
			const saved = await runtime.runPromise(
				automationAgentOperation(service, config.projectId, input),
			);
			const replay = await runtime.runPromise(
				automationAgentOperation(service, config.projectId, input),
			);
			expect(saved).toEqual(replay);
			expect(
				await runtime.runPromise(service.list(config.projectId)),
			).toHaveLength(1);
			const catalog = await runtime.runPromise(
				automationAgentOperation(service, config.projectId),
			);
			expect(catalog).toEqual(
				expect.objectContaining({
					projectId: config.projectId,
					definitionSchema: expect.any(Object),
					automations: [saved],
				}),
			);
			expect(JSON.stringify(catalog)).not.toContain("webhookToken");
		} finally {
			await runtime.dispose();
		}
	});
	it("rejects cross-project creation and updates, and requires a current revision", async () => {
		const { runtime, service } = await fixture();
		try {
			const own = await runtime.runPromise(
				service.save({ config: { ...config, enabled: false } }),
			);
			const input = {
				configJson: JSON.stringify({ ...config, enabled: false }),
				requestId: "edit",
				id: own.id,
			};
			await expect(
				runtime.runPromise(
					automationAgentOperation(service, config.projectId, input),
				),
			).rejects.toThrow(/expectedRevision/);
			await expect(
				runtime.runPromise(
					automationAgentOperation(service, FolderId.make("other"), {
						...input,
						configJson: JSON.stringify({
							...config,
							enabled: false,
							projectId: "other",
						}),
						expectedRevision: own.revision,
					}),
				),
			).rejects.toThrow(/current session/);
			await expect(
				runtime.runPromise(
					automationAgentOperation(service, FolderId.make("other"), {
						...input,
						id: undefined,
					}),
				),
			).rejects.toThrow(/current session/);
			const edit = {
				...input,
				expectedRevision: own.revision,
				configJson: JSON.stringify({
					...config,
					enabled: false,
					name: "Edited by agent",
				}),
			};
			await runtime.runPromise(
				automationAgentOperation(service, config.projectId, edit),
			);
			await expect(
				runtime.runPromise(
					automationAgentOperation(service, config.projectId, edit),
				),
			).rejects.toThrow();
			expect((await runtime.runPromise(service.get(own.id))).config.name).toBe(
				"Edited by agent",
			);
		} finally {
			await runtime.dispose();
		}
	});
});

it("binds native automation tools to the running registry and unregisters on shutdown", async () => {
	const { runtime, service } = await fixture();
	const tools = ManagedRuntime.make(
		AutomationAgentToolsLive.pipe(
			Layer.provide(Layer.succeed(AutomationRegistry, service)),
			Layer.provideMerge(AutomationAgentRouterLive),
		),
	);
	try {
		const router = await tools.runPromise(AutomationAgentRouter);
		await expect(
			router.call(config.projectId, {
				configJson: JSON.stringify({ ...config, enabled: false }),
				requestId: "through-router",
			}),
		).resolves.toMatchObject({
			ok: true,
			result: { config: { name: config.name, enabled: false } },
		});
		expect(
			await runtime.runPromise(service.list(config.projectId)),
		).toHaveLength(1);
		await tools.dispose();
		await expect(router.call(config.projectId)).resolves.toMatchObject({
			ok: false,
		});
	} finally {
		await tools.dispose();
		await runtime.dispose();
	}
});

it("denies native catalog and save in cloud until current administration is verified", async () => {
	const runtime = ManagedRuntime.make(makeAutomationAgentRouterLayer(true));
	try {
		const router = await runtime.runPromise(AutomationAgentRouter);
		let calls = 0;
		router.register(async () => {
			calls++;
			return { ok: true };
		});
		const actor = { subject: "editor", membershipId: "membership" };
		const input = {
			configJson: JSON.stringify({ ...config, enabled: true }),
			requestId: "denied",
		};
		await expect(router.call(config.projectId)).resolves.toMatchObject({
			ok: false,
		});
		let admin = false;
		const unbind = router.bindAuthorization(
			async (current) => current?.subject === actor.subject && admin,
		);
		await expect(
			router.call(config.projectId, undefined, actor),
		).resolves.toMatchObject({ ok: false });
		await expect(
			router.call(config.projectId, input, actor),
		).resolves.toMatchObject({ ok: false });
		expect(calls).toBe(0);
		admin = true;
		await expect(
			router.call(config.projectId, input, actor),
		).resolves.toMatchObject({ ok: true });
		admin = false;
		await expect(
			router.call(config.projectId, input, actor),
		).resolves.toMatchObject({ ok: false });
		unbind();
		expect(calls).toBe(1);
	} finally {
		await runtime.dispose();
	}
});

it("retains older active runs when recent terminal history is limited", async () => {
	const { runtime, service } = await fixture();
	try {
		const automation = await runtime.runPromise(service.save({ config }));
		const active = await runtime.runPromise(
			service.run(automation.id, "old-active"),
		);
		await runtime.runPromise(
			Effect.gen(function* () {
				const sql = yield* SqlClient.SqlClient;
				yield* sql`UPDATE automation_runs SET created_at='2000-01-01' WHERE id=${active.id}`;
				yield* sql`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<501) INSERT INTO automation_runs(id,automation_id,event_id,source,status,config_json,prompt,created_at) SELECT 'history-'||i,${automation.id},'history-'||i,'manual','skipped','{}','test','2026-11-05' FROM n`;
			}),
		);
		expect(
			(await runtime.runPromise(service.runs(automation.id, 1))).some(
				(run) => run.id === active.id,
			),
		).toBe(true);
		await runtime.runPromise(service.cancel(active.id));
	} finally {
		await runtime.dispose();
	}
});
