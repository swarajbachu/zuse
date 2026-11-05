import type { AppEnv, AppJob, QueueMessage } from "@zuse/slack/types";
import { isSlackWebhookTarget } from "@zuse/slack/webhook-target";
import worker from "@zuse/slack/worker";
import { Effect, Option } from "effect";
import { AutomationMailbox } from "../automation-mailbox.ts";
import { ApiConfiguration } from "../config.ts";
import type { ApiContext } from "../handler.ts";
import {
	getOrganizationName,
	listAccessibleOrganizations,
} from "../organizations.ts";
import { routeAccountWorkspaceRequest } from "../public-api-routes.ts";
import { expectedWorkosClientId, WorkosVerifier } from "../workos.ts";
import { resolveWorkspaceActorAccess } from "../workspace-authorization.ts";
import { SlackPersistence } from "./persistence.ts";

export interface SlackOptions {
	readonly publicOrigin: string;
	readonly workspaceAppOrigin?: string;
	readonly appId: string;
	readonly clientId: string;
	readonly clientSecret: string;
	readonly signingSecret: string;
	readonly queue: {
		send(job: AppJob, options?: { delaySeconds: number }): Promise<void>;
	};
	/** Runs the same mailbox/reconciliation handoff as external API requests. */
	readonly dispatch: (response: Response) => Promise<Response>;
}

export const makeSlackModule = (options: SlackOptions) =>
	Effect.gen(function* () {
		const context = yield* Effect.context<ApiContext>();
		const config = yield* ApiConfiguration;
		const identity = yield* WorkosVerifier;
		const persistence = yield* Effect.serviceOption(SlackPersistence);
		const automations = yield* Effect.serviceOption(AutomationMailbox);
		const clientId = expectedWorkosClientId(config.workosJwksUrl);
		if (
			Option.isNone(persistence) ||
			!clientId ||
			!config.cloudDataEncryptionKey
		)
			throw new Error("slack_not_configured");
		const run = <A, E>(
			effect: Effect.Effect<A, E, ApiContext>,
			signal?: AbortSignal,
		) => Effect.runPromise(effect.pipe(Effect.provide(context)), { signal });
		const env: AppEnv = {
			store: persistence.value,
			automations: Option.isSome(automations)
				? (accountId, input, organizationId) =>
						run(
							Effect.gen(function* () {
								const access = yield* resolveWorkspaceActorAccess(
									{ accountId, orgId: organizationId },
									organizationId
										? { kind: "organization", organizationId }
										: { kind: "personal" },
									"administration",
								);
								return yield* Effect.tryPromise({
									try: () =>
										automations.value.dispatchAccount(access.ownerId, input),
									catch: () => new Error("automation_dispatch_failed"),
								});
							}),
						)
				: undefined,
			APP_ORIGIN: options.publicOrigin,
			WORKSPACE_APP_ORIGIN: options.workspaceAppOrigin,
			SLACK_APP_ID: options.appId,
			SLACK_CLIENT_ID: options.clientId,
			SLACK_CLIENT_SECRET: options.clientSecret,
			SLACK_SIGNING_SECRET: options.signingSecret,
			JOBS: options.queue,
			identity: {
				clientId,
				exchange: (code, verifier) =>
					run(
						Effect.gen(function* () {
							const tokens = yield* identity.exchangeToken({
								grantType: "authorization_code",
								code,
								codeVerifier: verifier,
							});
							const principal = yield* identity.verify(tokens.access_token);
							if (
								principal.orgId === undefined ||
								!config.organizationWorkspacesEnabled
							)
								return { accountId: principal.accountId };
							yield* resolveWorkspaceActorAccess(
								principal,
								{ kind: "organization", organizationId: principal.orgId },
								"content",
							);
							return {
								accountId: principal.accountId,
								organization: {
									id: principal.orgId,
									name: yield* getOrganizationName(principal.orgId),
								},
							};
						}),
					),
				organizations: (accountId) =>
					config.organizationWorkspacesEnabled
						? run(
								listAccessibleOrganizations(accountId).pipe(
									Effect.map((organizations) =>
										organizations.filter(
											(organization) =>
												organization.role === "admin" ||
												organization.role === "member",
										),
									),
								),
							)
						: Promise.resolve([]),
			},
			cloud: (accountId, organizationId) => ({
				request: async (path, init) => {
					const response = await run(
						routeAccountWorkspaceRequest(
							new Request(new URL(path, config.apiIssuer), init),
							accountId,
							{
								githubBot: true,
								requireExplicitAgent: true,
								organizationId,
								internalWebhookTarget: (url) =>
									isSlackWebhookTarget(url, options.publicOrigin),
							},
						).pipe(
							Effect.catch((error) =>
								Effect.succeed(
									Response.json({ code: error.code }, { status: error.status }),
								),
							),
						),
						init.signal ?? undefined,
					);
					return options.dispatch(
						response ?? new Response("not found", { status: 404 }),
					);
				},
			}),
		};
		return {
			fetch: async (request: Request) => {
				const pending: Promise<unknown>[] = [];
				try {
					return await worker.fetch(request, env, {
						waitUntil: (task) => {
							pending.push(task);
						},
					});
				} finally {
					await Promise.allSettled(pending);
				}
			},
			queue: (batch: { readonly messages: ReadonlyArray<QueueMessage> }) =>
				worker.queue(batch, env),
		};
	});
