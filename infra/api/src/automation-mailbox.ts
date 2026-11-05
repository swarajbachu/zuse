import type { DurableObjectNamespace } from "@cloudflare/workers-types";

export { matchesAutomationEvent } from "@zuse/utils/automation-events";

import {
	type AutomationDispatchInput,
	AutomationTrigger,
} from "@zuse/contracts";
import type { Cipher, Database } from "@zuse/slack/installations";
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { openApiString, sealApiString } from "./api-sealing.ts";
import { ApiConfiguration } from "./config.ts";
import { githubLinkAllowsRepository } from "./github-link-access.ts";

export const AutomationRegistration = Schema.Struct({
	id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
	revision: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
	enabled: Schema.Boolean,
	notifications: Schema.optional(
		Schema.Array(
			Schema.Struct({
				channel: Schema.Literals(["email", "slack"]),
				destination: Schema.String.check(Schema.isMaxLength(200)),
			}),
		).check(Schema.isMaxLength(100)),
	),
	nextRunAt: Schema.optional(Schema.NullOr(Schema.String)),
	triggers: Schema.Array(AutomationTrigger).check(Schema.isMaxLength(20)),
});
export type AutomationRegistration = typeof AutomationRegistration.Type;
export interface AutomationExternalEvent {
	readonly eventId: string;
	readonly source: AutomationDispatchInput["source"];
	readonly prompt: string;
	readonly context: Readonly<Record<string, string>>;
}
/** The namespace is injected by the Worker; API tests can supply an isolated stub. */
export const AutomationDurableObjects = Context.Reference<
	DurableObjectNamespace | undefined
>("api/AutomationDurableObjects", { defaultValue: () => undefined });

/** Account-scoped routing. Postgres remains authority and a one-time legacy import source. */
export class AutomationMailboxStore {
	private readonly initialized = new Map<string, Promise<void>>();
	constructor(
		private readonly db: Database,
		_cipher: Cipher,
		private readonly namespace?: DurableObjectNamespace,
	) {}
	private stub(accountId: string) {
		if (!this.namespace) throw new Error("automation_scheduler_unavailable");
		return this.namespace.get(this.namespace.idFromName(accountId));
	}
	private async call<T>(
		accountId: string,
		path: string,
		body: Record<string, unknown>,
	): Promise<T> {
		const response = await this.stub(accountId).fetch(
			`https://automation.internal/${path}`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ ...body, accountId }),
			},
		);
		if (!response.ok)
			throw new Error(`automation_scheduler_${response.status}`);
		return response.json() as Promise<T>;
	}
	private async owner(workspaceId: string): Promise<string | null> {
		const rows = await this.db.query<{ account_id: string }>(
			"SELECT account_id FROM api_cloud_workspaces WHERE workspace_id=$1 AND state NOT IN ('deleted','deleting','archived','archiving')",
			[workspaceId],
		);
		return rows[0]?.account_id ?? null;
	}
	private ensure(accountId: string): Promise<void> {
		const current = this.initialized.get(accountId);
		if (current) return current;
		const operation = this.importLegacy(accountId);
		if (this.initialized.size >= 256) {
			const oldest = this.initialized.keys().next().value;
			if (oldest) this.initialized.delete(oldest);
		}
		this.initialized.set(accountId, operation);
		operation.catch(() => this.initialized.delete(accountId));
		return operation;
	}
	private async importLegacy(accountId: string): Promise<void> {
		if (
			(await this.call<{ initialized: boolean }>(accountId, "initialized", {}))
				.initialized
		)
			return;
		const [registrations, events, notifications] = await Promise.all([
			this.db.query<Record<string, unknown>>(
				"SELECT r.* FROM api_automation_registrations r JOIN api_cloud_workspaces w USING(workspace_id) WHERE r.account_id=$1 AND w.account_id=$1 AND w.state NOT IN ('deleted','deleting','archived','archiving')",
				[accountId],
			),
			this.db.query<Record<string, unknown>>(
				"SELECT e.* FROM api_automation_events e JOIN api_automation_registrations r USING(workspace_id,automation_id) JOIN api_cloud_workspaces w USING(workspace_id) WHERE r.account_id=$1 AND w.account_id=$1 AND w.state NOT IN ('deleted','deleting','archived','archiving')",
				[accountId],
			),
			this.db.query<Record<string, unknown>>(
				"SELECT n.* FROM api_automation_notifications n JOIN api_cloud_workspaces w USING(workspace_id) WHERE w.account_id=$1 AND w.state NOT IN ('deleted','deleting','archived','archiving')",
				[accountId],
			),
		]);
		const normalize = (rows: readonly Record<string, unknown>[]) =>
			rows.map((row) =>
				Object.fromEntries(
					Object.entries(row).map(([key, value]) => [
						key,
						value !== null &&
						[
							"revision",
							"next_run_at",
							"created_at",
							"expires_at",
							"acknowledged_at",
							"completed_at",
							"delivered_at",
						].includes(key)
							? Number(value)
							: key === "enabled"
								? Boolean(value)
								: value,
					]),
				),
			);
		await this.call(accountId, "import", {
			registrations: normalize(registrations),
			events: normalize(events),
			notifications: normalize(notifications),
		});
	}
	/** Explicit deployment bootstrap for dormant owners; never called by scheduled polling. */
	async migrateLegacyOwners(
		afterAccountId = "",
		limit = 100,
	): Promise<{ accountIds: readonly string[]; next: string | null }> {
		const owners = await this.db.query<{ account_id: string }>(
			"SELECT DISTINCT account_id FROM api_automation_registrations WHERE account_id>$1 ORDER BY account_id LIMIT $2",
			[afterAccountId, Math.min(100, Math.max(1, limit))],
		);
		for (const owner of owners) await this.ensure(owner.account_id);
		return {
			accountIds: owners.map((owner) => owner.account_id),
			next: owners.at(-1)?.account_id ?? null,
		};
	}
	async register(
		accountId: string,
		workspaceId: string,
		definitions: readonly AutomationRegistration[],
	): Promise<readonly { automationId: string; token: string }[]> {
		await this.ensure(accountId);
		return (
			await this.call<{ hooks: { automationId: string; token: string }[] }>(
				accountId,
				"register",
				{ workspaceId, definitions },
			)
		).hooks;
	}
	async dispatchAccount(
		accountId: string,
		event: AutomationExternalEvent,
	): Promise<number> {
		await this.ensure(accountId);
		const rows = await this.db.query<{ workspace_id: string }>(
			"SELECT workspace_id FROM api_cloud_workspaces WHERE account_id=$1 AND state NOT IN ('deleted','deleting','archived','archiving')",
			[accountId],
		);
		return (
			await this.call<{ accepted: number }>(accountId, "dispatch", {
				event,
				workspaceIds: rows.map((row) => row.workspace_id),
			})
		).accepted;
	}
	async dispatchGithub(
		installationId: number,
		event: AutomationExternalEvent,
	): Promise<number> {
		const accounts = await this.db.query<{
			account_id: string;
			allowed_repositories: string[] | null;
		}>(
			"SELECT account_id, allowed_repositories FROM api_cloud_github_installations WHERE installation_id=$1 AND suspended=false",
			[installationId],
		);
		let count = 0;
		for (const account of accounts)
			if (
				githubLinkAllowsRepository(
					account.allowed_repositories ?? undefined,
					event.context.repository ?? "",
				)
			)
				count += await this.dispatchAccount(account.account_id, event);
		return count;
	}
	async webhook(
		workspaceId: string,
		automationId: string,
		token: string,
		event: AutomationExternalEvent,
	): Promise<boolean> {
		if (!/^[a-f0-9]{64}$/u.test(token)) return false;
		const accountId = await this.owner(workspaceId);
		if (!accountId) return false;
		await this.ensure(accountId);
		return (
			await this.call<{ accepted: boolean }>(accountId, "webhook", {
				workspaceId,
				automationId,
				token,
				event,
			})
		).accepted;
	}
	async pending(
		workspaceId: string,
	): Promise<readonly (AutomationDispatchInput & { id: string })[]> {
		const accountId = await this.owner(workspaceId);
		if (!accountId) return [];
		await this.ensure(accountId);
		return (
			await this.call<{ events: (AutomationDispatchInput & { id: string })[] }>(
				accountId,
				"pending",
				{ workspaceId },
			)
		).events;
	}
	async connect(workspaceId: string, request: Request): Promise<Response> {
		const accountId = await this.owner(workspaceId);
		if (!accountId) return new Response(null, { status: 404 });
		await this.ensure(accountId);
		const url = new URL("https://automation.internal/connect");
		url.searchParams.set("accountId", accountId);
		url.searchParams.set("workspaceId", workspaceId);
		const headers: Record<string, string> = {};
		request.headers.forEach((value, key) => {
			headers[key] = value;
		});
		return (await this.stub(accountId).fetch(url.toString(), {
			method: request.method,
			headers,
		})) as unknown as Response;
	}
	async notificationTarget(
		workspaceId: string,
		automationId: string,
		destination: string,
	): Promise<{
		accountId: string;
		delivered: (runId: string) => Promise<boolean>;
	} | null> {
		const accountId = await this.owner(workspaceId);
		if (!accountId) return null;
		await this.ensure(accountId);
		const target = async (runId?: string) =>
			(
				await this.call<{
					target: { accountId: string; delivered: boolean } | null;
				}>(accountId, "notification-target", {
					workspaceId,
					automationId,
					destination,
					runId,
				})
			).target;
		if (!(await target())) return null;
		return {
			accountId,
			delivered: async (runId) => (await target(runId))?.delivered ?? false,
		};
	}
	async slackTeams(accountId: string): Promise<readonly { team_id: string }[]> {
		return this.db.query<{ team_id: string }>(
			"SELECT i.team_id FROM api_slack_installations i LEFT JOIN api_slack_members m ON i.team_id=m.team_id AND i.generation=m.generation AND i.owner_id=m.user_id WHERE m.account_id=$1 OR (m.user_id IS NULL AND i.account_id=$1)",
			[accountId],
		);
	}
	private async workspaceCall(
		workspaceId: string,
		path: string,
		body: Record<string, unknown>,
	): Promise<void> {
		const accountId = await this.owner(workspaceId);
		if (!accountId) return;
		await this.ensure(accountId);
		await this.call(accountId, path, { ...body, workspaceId });
	}
	async notificationDelivered(
		workspaceId: string,
		automationId: string,
		runId: string,
		destination: string,
	): Promise<void> {
		await this.workspaceCall(workspaceId, "notification-delivered", {
			automationId,
			runId,
			destination,
		});
	}
	async resultEvent(
		workspaceId: string,
		id: string,
	): Promise<(AutomationDispatchInput & { accountId: string }) | null> {
		const accountId = await this.owner(workspaceId);
		if (!accountId) return null;
		await this.ensure(accountId);
		return (
			await this.call<{
				event: (AutomationDispatchInput & { accountId: string }) | null;
			}>(accountId, "result", { workspaceId, id })
		).event;
	}
	async complete(workspaceId: string, id: string): Promise<void> {
		await this.workspaceCall(workspaceId, "complete", { id });
	}
	async ack(
		workspaceId: string,
		id: string,
		rejection?: string,
	): Promise<void> {
		await this.workspaceCall(workspaceId, "ack", { id, rejection });
	}
}
export class AutomationMailbox extends Context.Service<
	AutomationMailbox,
	AutomationMailboxStore
>()("api/AutomationMailbox") {}
export const AutomationMailboxLive = Layer.effect(
	AutomationMailbox,
	Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		const config = yield* ApiConfiguration;
		const namespace = yield* AutomationDurableObjects;
		const run = (operation: Effect.Effect<string, unknown, ApiConfiguration>) =>
			Effect.runPromise(
				operation.pipe(Effect.provideService(ApiConfiguration, config)),
			);
		return new AutomationMailboxStore(
			{
				query: (query, values = []) =>
					Effect.runPromise(sql.unsafe(query, [...values])),
			},
			{
				seal: (context, value) => run(sealApiString(context, value)),
				open: (context, value) => run(openApiString(context, value)),
			},
			namespace,
		);
	}),
);
