import { readFileSync } from "node:fs";
import { InstallationStore } from "@zuse/slack/installations";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AutomationExternalEvent,
	AutomationMailboxStore,
	type AutomationRegistration,
	matchesAutomationEvent,
} from "../../src/automation-mailbox.ts";
import { deliverAutomationNotification } from "../../src/automation-results.ts";
import { SlackPersistence } from "../../src/slack/persistence.ts";
import { testCipher, testDatabase } from "../slack/test-support.ts";
import { automationNamespaceFixture } from "../support/automation-object.ts";

const github = {
	_tag: "github",
	events: ["pull_request"],
	repositories: ["zuse/zuse"],
	actions: ["opened"],
} as const;
const event: AutomationExternalEvent = {
	source: "github",
	eventId: "delivery-1",
	prompt: "Untrusted PR evidence",
	context: { event: "pull_request", action: "opened", repository: "zuse/zuse" },
};
const fixtures: ReturnType<typeof testDatabase>[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	for (const fixture of fixtures.splice(0)) fixture.sqlite.close();
});
const fixture = async () => {
	const db = testDatabase();
	const durable = automationNamespaceFixture();
	fixtures.push(db);
	db.sqlite.exec(
		"CREATE TABLE api_cloud_workspaces (workspace_id text PRIMARY KEY, account_id text, state text); CREATE TABLE api_cloud_github_installations (account_id text, installation_id integer, suspended boolean, allowed_repositories text);",
	);
	db.sqlite.exec(
		readFileSync(
			new URL(
				"../../drizzle/migrations/0048_automation_event_mailbox.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	db.sqlite.exec(
		"INSERT INTO api_cloud_workspaces VALUES ('workspace-a','account-a','ready'),('workspace-b','account-b','ready'); INSERT INTO api_cloud_github_installations VALUES ('account-a',42,false,null),('account-b',43,false,null);",
	);
	const add = async (
		workspaceId: string,
		accountId: string,
		definition: AutomationRegistration,
	) => {
		const sealed = await testCipher.seal(
			`automation-registration:${workspaceId}:${definition.id}`,
			JSON.stringify(definition),
		);
		const hook = await testCipher.seal(
			`automation-registration:${workspaceId}:${definition.id}:hook`,
			"a".repeat(64),
		);
		db.sqlite
			.prepare(
				"INSERT INTO api_automation_registrations (workspace_id,account_id,automation_id,revision,enabled,sealed,webhook_token_sealed) VALUES (?,?,?,?,?,?,?)",
			)
			.run(
				workspaceId,
				accountId,
				definition.id,
				definition.revision,
				definition.enabled ? 1 : 0,
				sealed,
				hook,
			);
	};
	await add("workspace-a", "account-a", {
		id: "rule-a",
		revision: 1,
		enabled: true,
		triggers: [github, { _tag: "webhook" }],
	});
	await add("workspace-b", "account-b", {
		id: "rule-b",
		revision: 1,
		enabled: true,
		triggers: [github],
	});
	return {
		...db,
		add,
		durable,
		store: new AutomationMailboxStore(
			db.binding,
			testCipher,
			durable.namespace,
		),
	};
};

describe("automation event mailbox", () => {
	it("imports delivery and notification receipts once without writing legacy tables", async () => {
		const { store, sqlite, binding, durable, add } = await fixture();
		await add("workspace-a", "account-a", {
			id: "notify",
			revision: 1,
			enabled: true,
			triggers: [{ _tag: "webhook" }],
			notifications: [{ channel: "slack", destination: "T1/C1" }],
		});
		const input = { ...event, automationId: "rule-a" };
		const sealed = await testCipher.seal(
			"automation-event:workspace-a:legacy-event",
			JSON.stringify(input),
		);
		sqlite
			.prepare(
				"INSERT INTO api_automation_events (id,workspace_id,automation_id,revision,event_id,source,sealed,created_at,expires_at,acknowledged_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
			)
			.run(
				"legacy-event",
				"workspace-a",
				"rule-a",
				1,
				event.eventId,
				event.source,
				sealed,
				Date.now(),
				Date.now() + 86400000,
				Date.now(),
				Date.now(),
			);
		sqlite
			.prepare("INSERT INTO api_automation_notifications VALUES (?,?,?,?,?)")
			.run("workspace-a", "notify", "run-1", "T1/C1", Date.now());
		const query = vi.spyOn(binding, "query");
		await store.dispatchAccount("account-a", event);
		expect(await store.pending("workspace-a")).toEqual([]);
		expect(await store.resultEvent("workspace-a", "legacy-event")).toBeNull();
		expect(
			await (
				await store.notificationTarget("workspace-a", "notify", "T1/C1")
			)?.delivered("run-1"),
		).toBe(true);
		expect(
			query.mock.calls.filter(([sql]) =>
				sql.includes("FROM api_automation_registrations r"),
			),
		).toHaveLength(1);
		expect(query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(
			true,
		);
		const reconstructed = new AutomationMailboxStore(
			binding,
			testCipher,
			durable.namespace,
		);
		query.mockClear();
		await reconstructed.pending("workspace-a");
		expect(
			query.mock.calls.some(([sql]) => sql.includes("api_automation_")),
		).toBe(false);
	});

	it("explicitly bootstraps dormant owners and excludes archived workspace dispatch", async () => {
		const { store, sqlite, durable } = await fixture();
		expect(await store.migrateLegacyOwners()).toEqual({
			accountIds: ["account-a", "account-b"],
			next: "account-b",
		});
		expect(durable.objects.size).toBe(2);
		for (const state of ["deleted", "deleting", "archived", "archiving"]) {
			sqlite
				.prepare(
					"UPDATE api_cloud_workspaces SET state=? WHERE workspace_id='workspace-a'",
				)
				.run(state);
			expect(await store.dispatchAccount("account-a", event)).toBe(0);
			expect(await store.pending("workspace-a")).toEqual([]);
		}
	});

	it("reserves serialized context capacity for the trusted mailbox identity", async () => {
		const { store } = await fixture();
		const base = { ...event.context, text: "" };
		const context = {
			...base,
			text: "x".repeat(59500 - JSON.stringify(base).length),
		};
		expect(JSON.stringify(context)).toHaveLength(59500);
		await expect(
			store.dispatchAccount("account-a", { ...event, context }),
		).rejects.toThrow("automation_event_reserved_context");
		await store.dispatchAccount("account-a", {
			...event,
			context: { ...base, text: "x".repeat(58000) },
		});
		expect(await store.pending("workspace-a")).toHaveLength(1);
	});

	it("reserves the trusted mailbox identity and one context slot before persistence", async () => {
		const { store } = await fixture();
		const extra = Object.fromEntries(
			Array.from({ length: 97 }, (_, index) => [`key${index}`, "value"]),
		);
		await expect(
			store.dispatchAccount("account-a", {
				...event,
				context: { ...event.context, ...extra },
			}),
		).rejects.toThrow("automation_event_reserved_context");
		await expect(
			store.dispatchAccount("account-a", {
				...event,
				context: { ...event.context, mailboxEventId: "forged" },
			}),
		).rejects.toThrow("automation_event_reserved_context");
		delete extra.key96;
		await store.dispatchAccount("account-a", {
			...event,
			context: { ...event.context, ...extra },
		});
		const pending = await store.pending("workspace-a");
		expect(Object.keys(pending[0]?.context ?? {})).toHaveLength(99);
	});

	it("delivers configured Slack notifications only through the owning installation and deduplicates retries", async () => {
		const { store, add, binding } = await fixture();
		await add("workspace-a", "account-a", {
			id: "notify",
			revision: 1,
			enabled: true,
			triggers: [{ _tag: "webhook" }],
			notifications: [{ channel: "slack", destination: "T1/C1" }],
		});
		const slack = new InstallationStore(binding, testCipher);
		await slack.install({
			teamId: "T1",
			ownerId: "U1",
			generation: "generation",
			revision: 0,
			credentials: {
				botToken: "bot-token",
				userToken: "owner-token",
				botUserId: "UBOT",
				rules: [],
				zuse: {
					accountId: "account-a",
					webhookId: "hook",
					webhookSecret: "secret",
				},
			},
		});
		const requests: Array<{
			method: string;
			authorization: string;
			body: Record<string, unknown>;
		}> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			requests.push({
				method: url.split("/").at(-1) ?? "",
				authorization: new Headers(init.headers).get("authorization") ?? "",
				body: JSON.parse(String(init.body)),
			});
			return Response.json({ ok: true, ts: "123.456", messages: [] });
		});
		const deliver = (destination: string) =>
			Effect.runPromise(
				deliverAutomationNotification(store, "workspace-a", {
					automationId: "notify",
					runId: "run-1",
					destination,
					text: "Completed safely.",
				}).pipe(Effect.provideService(SlackPersistence, slack)),
			);
		await expect(deliver("T1/C2")).rejects.toMatchObject({ _tag: "ApiError" });
		expect(requests).toEqual([]);
		await deliver("T1/C1");
		await deliver("T1/C1");
		expect(requests.map((request) => request.method)).toEqual([
			"conversations.history",
			"chat.postMessage",
		]);
		expect(requests[0]?.authorization).toBe("Bearer owner-token");
		expect(requests[1]?.authorization).toBe("Bearer bot-token");
		expect(requests[1]?.body).toMatchObject({
			channel: "C1",
			text: "Completed safely.",
		});
	});

	it("rejects oversized context before it can poison pending delivery", async () => {
		const { store } = await fixture();
		await expect(
			store.dispatchAccount("account-a", {
				...event,
				context: { ...event.context, text: "x".repeat(60001) },
			}),
		).rejects.toThrow();
		expect(await store.pending("workspace-a")).toEqual([]);
	});

	it("enforces the linked member's repository scope for GitHub deliveries", async () => {
		const { store, binding } = await fixture();
		const query = binding.query;
		vi.spyOn(binding, "query").mockImplementation(async (sql, values) => {
			if (sql.startsWith("SELECT account_id, allowed_repositories"))
				return [
					{ account_id: "account-a", allowed_repositories: ["other/private"] },
				];
			return query(sql, values);
		});
		expect(await store.dispatchGithub(42, event)).toBe(0);
		expect(await store.pending("workspace-a")).toEqual([]);
	});
	it("routes signed GitHub installations to the owning account only and deduplicates redelivery", async () => {
		const { store, durable } = await fixture();
		await store.dispatchGithub(42, event);
		await store.dispatchGithub(42, event);
		const pending = await store.pending("workspace-a");
		expect(pending).toHaveLength(1);
		expect(pending[0]).toMatchObject({
			automationId: "rule-a",
			eventId: "delivery-1",
			source: "github",
		});
		expect(await store.pending("workspace-b")).toEqual([]);
		expect(
			JSON.stringify([...durable.object("account-a").records.values()]),
		).not.toContain(event.prompt);
		await store.ack("workspace-b", pending[0]?.id ?? "missing-event");
		expect(await store.pending("workspace-a")).toHaveLength(1);
		await store.ack("workspace-a", pending[0]?.id ?? "missing-event");
		await store.dispatchGithub(42, event);
		expect(await store.pending("workspace-a")).toEqual([]);
	});
	it("suppresses queued events after disabling or editing an automation", async () => {
		const { store } = await fixture();
		await store.dispatchAccount("account-a", event);
		await store.register("account-a", "workspace-a", [
			{ id: "rule-a", revision: 1, enabled: false, triggers: [github] },
		]);
		expect(await store.pending("workspace-a")).toEqual([]);
		await store.register("account-a", "workspace-a", [
			{ id: "rule-a", revision: 2, enabled: true, triggers: [github] },
		]);
		expect(await store.pending("workspace-a")).toEqual([]);
	});
	it("rejects wrong webhook credentials and keeps source trigger checks", async () => {
		const { store } = await fixture();
		const hook = { ...event, source: "webhook" as const };
		expect(
			await store.webhook("workspace-a", "rule-a", "b".repeat(64), hook),
		).toBe(false);
		expect(
			await store.webhook("workspace-b", "rule-a", "a".repeat(64), hook),
		).toBe(false);
		expect(
			await store.webhook("workspace-a", "rule-a", "a".repeat(64), {
				...hook,
				source: "security_scan",
			}),
		).toBe(false);
		expect(
			await store.webhook("workspace-a", "rule-a", "a".repeat(64), hook),
		).toBe(true);
		expect(await store.pending("workspace-a")).toHaveLength(1);
	});
	it("applies repository, action, channel, bot, and literal keyword restrictions", () => {
		expect(matchesAutomationEvent(github, event)).toBe(true);
		expect(
			matchesAutomationEvent(github, {
				...event,
				context: { ...event.context, repository: "attacker/repo" },
			}),
		).toBe(false);
		expect(
			matchesAutomationEvent(github, {
				...event,
				context: { ...event.context, action: "closed" },
			}),
		).toBe(false);
		const trigger = {
			_tag: "slack",
			events: ["message"],
			channelIds: ["C1"],
			keywords: ["production error"],
			includeBotMessages: false,
		} as const;
		const slack = {
			source: "slack",
			eventId: "evt",
			prompt: "",
			context: { event: "message", channelId: "C1", text: "PRODUCTION ERROR" },
		} as const;
		expect(matchesAutomationEvent(trigger, slack)).toBe(true);
		expect(
			matchesAutomationEvent(trigger, {
				...slack,
				context: { ...slack.context, botId: "B1" },
			}),
		).toBe(false);
		expect(
			matchesAutomationEvent(
				{ ...trigger, includeBotMessages: true },
				{ ...slack, context: { ...slack.context, botId: "B1" } },
			),
		).toBe(true);
		expect(
			matchesAutomationEvent(trigger, {
				...slack,
				context: { ...slack.context, channelId: "C2" },
			}),
		).toBe(false);
	});
});
