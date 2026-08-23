import {
	ApiPaths,
	ApiSendMessageRequest,
	ApiWebhookCreateRequest,
	ApiWorkspaceCreateRequest,
} from "@zuse/contracts";
import { Clock, Effect, Schema } from "effect";
import {
	apiMessageSealContext,
	apiWebhookSecretSealContext,
	openApiString,
	sealApiString,
} from "./api-sealing.ts";
import { requireApiKey } from "./auth.ts";
import {
	type CloudWorkspaceRouteContext,
	createCloudWorkspaceForAccount,
	queueCloudWorkspaceResume,
	requireCloudBillingCapacity,
	startupPhase,
} from "./cloud-workspace-routes.ts";
import {
	type ApiWebhookRecord,
	type CloudWorkspaceApiMessageRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import { type ApiError, badRequest, conflict, notFound } from "./errors.ts";

// The `/v1/api/**` surface: the machine-caller (API-key) counterpart of the
// first-party `/v1/cloud/**` routes. It exposes only the core loop — create a
// workspace with a prompt, send follow-up messages, poll the conversation
// ledger, manage webhook endpoints — and shares the underlying create/resume
// implementations with the WorkOS surface.

/** Ledger rows fetched per workspace; the ledger is bounded by design. */
const API_MESSAGE_SCAN_LIMIT = 1_000;
const API_MESSAGE_PAGE_LIMIT = 200;
const API_MESSAGE_EXPIRY_MS = 24 * 60 * 60 * 1_000;
const API_PROMPT_MAX_LENGTH = 65_536;

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const decodeBody = <A, I>(
	schema: Schema.Codec<A, I>,
	request: Request,
): Effect.Effect<A, ApiError> =>
	Effect.tryPromise({
		try: (): Promise<unknown> => request.json(),
		catch: () => badRequest("invalid_json"),
	}).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(schema)),
		Effect.mapError(() => badRequest("invalid_request")),
	);

const requestConfigString = (
	workspace: CloudWorkspaceRecord,
	key: string,
): string | undefined =>
	typeof workspace.requestConfig[key] === "string"
		? (workspace.requestConfig[key] as string)
		: undefined;

const gatewayEpoch = (workspace: CloudWorkspaceRecord): number =>
	typeof workspace.requestConfig.gatewayEpoch === "number"
		? workspace.requestConfig.gatewayEpoch
		: typeof workspace.requestConfig.runtimeGeneration === "number"
			? workspace.requestConfig.runtimeGeneration
			: 1;

const workspaceAcceptsMessages = (workspace: CloudWorkspaceRecord): boolean =>
	!["archiving", "archived", "deleting", "deleted", "failed"].includes(
		workspace.state,
	) && workspace.desiredState !== "deleted";

const idempotentMessageId = Effect.fn("idempotentApiMessageId")(function* (
	accountId: string,
	workspaceId: string,
	idempotencyKey: string | undefined,
) {
	if (idempotencyKey === undefined) return yield* randomToken("msg", 16);
	const hash = yield* sha256Hex(
		`api-message-v1\n${accountId}\n${workspaceId}\n${idempotencyKey}`,
	);
	return `msg_${hash.slice(0, 40)}`;
});

const publicApiMessage = Effect.fn("publicApiMessage")(function* (
	message: CloudWorkspaceApiMessageRecord,
) {
	const text = yield* openApiString(
		apiMessageSealContext(message.accountId, message.workspaceId),
		message.sealedContent,
	);
	return {
		messageId: message.messageId,
		seq: message.seq,
		role: message.role,
		text,
		status: message.status,
		...(message.turnId === undefined ? {} : { turnId: message.turnId }),
		...(message.outcome === undefined ? {} : { outcome: message.outcome }),
		createdAt: message.createdAtMs,
	};
});

const apiWorkspaceStatus = Effect.fn("apiWorkspaceStatus")(function* (
	workspace: CloudWorkspaceRecord,
) {
	const store = yield* CloudWorkspaceStore;
	const ledger = yield* store.listApiMessages(
		workspace.workspaceId,
		0,
		API_MESSAGE_SCAN_LIMIT,
	);
	const latestSeq = ledger.length > 0 ? (ledger.at(-1)?.seq ?? 0) : 0;
	const lastAssistant = [...ledger]
		.reverse()
		.find((message) => message.role === "assistant");
	const outstanding = ledger.some(
		(message) =>
			message.role === "user" &&
			(message.status === "pending" || message.status === "delivered"),
	);
	return {
		workspaceId: workspace.workspaceId,
		projectId: workspace.projectId,
		branch: workspace.branch,
		baseRef: workspace.baseRef,
		state: workspace.state,
		statusCode: workspace.statusCode,
		startupPhase: startupPhase(workspace),
		runtimeState: workspace.runtimeState,
		agentStatus: outstanding
			? ("working" as const)
			: lastAssistant !== undefined
				? ("idle" as const)
				: ("unknown" as const),
		latestSeq,
		lastTurn:
			lastAssistant?.turnId === undefined
				? null
				: {
						turnId: lastAssistant.turnId,
						outcome: lastAssistant.outcome ?? "unknown",
						completedAt: lastAssistant.createdAtMs,
					},
		createdAt: workspace.createdAtMs,
		updatedAt: workspace.updatedAtMs,
	};
});

const publicWebhook = (webhook: ApiWebhookRecord) => ({
	webhookId: webhook.webhookId,
	url: webhook.url,
	...(webhook.description === undefined
		? {}
		: { description: webhook.description }),
	createdAt: webhook.createdAtMs,
});

export const routePublicApiRequest = (
	request: Request,
): Effect.Effect<Response | null, ApiError, CloudWorkspaceRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		if (!path.startsWith("/v1/api/")) return null;
		const store = yield* CloudWorkspaceStore;
		const nowMs = yield* Clock.currentTimeMillis;
		const principal = yield* requireApiKey(request);
		const headerIdempotencyKey =
			request.headers.get("idempotency-key") ?? undefined;

		if (method === "GET" && path === ApiPaths.apiProjects) {
			const projects = yield* store.listProjects(principal.accountId);
			return json({
				projects: projects.map((project) => ({
					projectId: project.projectId,
					repository: project.repositoryIdentity,
					displayName: project.displayName,
					defaultBranch: project.defaultBranch,
					state: project.state,
				})),
			});
		}

		if (method === "POST" && path === ApiPaths.apiWorkspaces) {
			const body = yield* decodeBody(ApiWorkspaceCreateRequest, request);
			const prompt = body.prompt.trim();
			if (prompt.length === 0 || prompt.length > API_PROMPT_MAX_LENGTH)
				return yield* Effect.fail(badRequest("invalid_prompt"));
			const projects = yield* store.listProjects(principal.accountId);
			const readyProjects = projects.filter(
				(project) => project.state === "ready",
			);
			const project =
				body.projectId === undefined
					? readyProjects.length === 1
						? readyProjects[0]
						: undefined
					: projects.find(
							(candidate) => candidate.projectId === body.projectId,
						);
			if (project === undefined)
				return yield* Effect.fail(
					body.projectId === undefined
						? badRequest("cloud_project_required")
						: notFound("cloud_project_not_found"),
				);
			const recent = [
				...(yield* store.listWorkspaces(principal.accountId)),
			].sort((a, b) => b.createdAtMs - a.createdAtMs)[0];
			const agent =
				body.agent ??
				(recent === undefined
					? undefined
					: requestConfigString(recent, "agent"));
			const model =
				body.model ??
				(recent === undefined
					? undefined
					: requestConfigString(recent, "model"));
			if (agent === undefined || model === undefined)
				return yield* Effect.fail(badRequest("agent_and_model_required"));
			const idempotencyKey =
				body.idempotencyKey ??
				headerIdempotencyKey ??
				(yield* randomToken("apicreate", 16));
			const { workspace, created } = yield* createCloudWorkspaceForAccount(
				principal.accountId,
				{
					projectId: project.projectId,
					providerId: body.providerId ?? recent?.provider,
					baseRef: body.baseRef ?? project.defaultBranch,
					...(body.branch === undefined ? {} : { branch: body.branch }),
					agent,
					model,
					firstMessage: prompt,
					idempotencyKey: `api:${idempotencyKey}`,
				},
				nowMs,
			);
			// Mirror the launch prompt into the conversation ledger so polling
			// clients see the full exchange. The launch intent itself delivers the
			// prompt; the ledger row is settled by the first turn event.
			const sealedPrompt = yield* sealApiString(
				apiMessageSealContext(principal.accountId, workspace.workspaceId),
				prompt,
			);
			yield* store.appendApiMessage({
				messageId: `msg_launch_${workspace.workspaceId}`,
				workspaceId: workspace.workspaceId,
				accountId: principal.accountId,
				role: "user",
				sealedContent: sealedPrompt,
				commandId: `launch:${workspace.workspaceId}`,
				status: "delivered",
				createdAtMs: nowMs,
			});
			const response = json(
				{ workspace: yield* apiWorkspaceStatus(workspace) },
				created ? 201 : 200,
			);
			if (created) {
				response.headers.set(
					"x-zuse-reconcile-cloud-pool",
					principal.accountId,
				);
				response.headers.set(
					"x-zuse-reconcile-cloud-workspace",
					workspace.workspaceId,
				);
			}
			return response;
		}

		if (method === "GET" && path === ApiPaths.apiWorkspaces) {
			const workspaces = yield* store.listWorkspaces(principal.accountId);
			const visible = workspaces.filter(
				(workspace) => workspace.state !== "deleted",
			);
			const statuses = yield* Effect.forEach(visible, (workspace) =>
				apiWorkspaceStatus(workspace),
			);
			return json({ workspaces: statuses });
		}

		const workspaceMatch = /^\/v1\/api\/workspaces\/([^/]+)$/u.exec(path);
		const messagesMatch = /^\/v1\/api\/workspaces\/([^/]+)\/messages$/u.exec(
			path,
		);
		const workspaceId = decodeURIComponent(
			workspaceMatch?.[1] ?? messagesMatch?.[1] ?? "",
		);
		if (workspaceMatch !== null || messagesMatch !== null) {
			const workspace = yield* store.getWorkspace(workspaceId);
			if (
				workspace === null ||
				workspace.accountId !== principal.accountId ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));

			if (method === "GET" && workspaceMatch !== null)
				return json({ workspace: yield* apiWorkspaceStatus(workspace) });

			if (method === "GET" && messagesMatch !== null) {
				const afterSeq = Number(url.searchParams.get("afterSeq") ?? "0");
				const limitParam = Number(
					url.searchParams.get("limit") ?? `${API_MESSAGE_PAGE_LIMIT}`,
				);
				if (
					!Number.isSafeInteger(afterSeq) ||
					afterSeq < 0 ||
					!Number.isSafeInteger(limitParam) ||
					limitParam <= 0
				)
					return yield* Effect.fail(badRequest("invalid_message_query"));
				const limit = Math.min(limitParam, API_MESSAGE_PAGE_LIMIT);
				const rows = yield* store.listApiMessages(workspaceId, afterSeq, limit);
				const messages = yield* Effect.forEach(rows, (row) =>
					publicApiMessage(row),
				);
				return json({
					messages,
					latestSeq:
						messages.length > 0 ? (messages.at(-1)?.seq ?? afterSeq) : afterSeq,
				});
			}

			if (method === "POST" && messagesMatch !== null) {
				if (!workspaceAcceptsMessages(workspace))
					return yield* Effect.fail(
						conflict("workspace_not_accepting_messages"),
					);
				const body = yield* decodeBody(ApiSendMessageRequest, request);
				const text = body.text.trim();
				if (text.length === 0 || text.length > API_PROMPT_MAX_LENGTH)
					return yield* Effect.fail(badRequest("invalid_message"));
				const messageId = yield* idempotentMessageId(
					principal.accountId,
					workspaceId,
					body.idempotencyKey ?? headerIdempotencyKey,
				);
				const sealed = yield* sealApiString(
					apiMessageSealContext(principal.accountId, workspaceId),
					text,
				);
				const appended = yield* store.appendApiMessage({
					messageId,
					workspaceId,
					accountId: principal.accountId,
					role: "user",
					sealedContent: sealed,
					commandId: `api:${messageId}`,
					status: "pending",
					createdAtMs: nowMs,
					expiresAtMs: nowMs + API_MESSAGE_EXPIRY_MS,
				});
				const needsResume =
					workspace.state === "paused" ||
					workspace.state === "pausing" ||
					workspace.desiredState === "paused";
				if (needsResume) {
					yield* requireCloudBillingCapacity(principal.accountId, nowMs);
					yield* queueCloudWorkspaceResume(
						workspace,
						`api-resume:${messageId}`,
						nowMs,
					);
				}
				const response = json({
					messageId: appended.message.messageId,
					seq: appended.message.seq,
					status:
						appended.message.status === "pending" ? "queued" : "delivered",
					resumeTriggered: needsResume,
				});
				if (needsResume) {
					response.headers.set("x-zuse-reconcile-cloud-workspace", workspaceId);
				} else if (workspace.runtimeState === "online") {
					response.headers.set(
						"x-zuse-nudge-cloud-workspace",
						`${workspaceId}:${gatewayEpoch(workspace)}`,
					);
				}
				return response;
			}
		}

		if (method === "POST" && path === ApiPaths.apiWebhooks) {
			const body = yield* decodeBody(ApiWebhookCreateRequest, request);
			let target: URL;
			try {
				target = new URL(body.url);
			} catch {
				return yield* Effect.fail(badRequest("invalid_webhook_url"));
			}
			if (
				(target.protocol !== "https:" && target.protocol !== "http:") ||
				body.url.length > 2_048
			)
				return yield* Effect.fail(badRequest("invalid_webhook_url"));
			const description = body.description?.trim();
			if (description !== undefined && description.length > 200)
				return yield* Effect.fail(badRequest("invalid_webhook_description"));
			const webhookId = yield* randomToken("wh", 8);
			const secret = yield* randomToken("whsec", 32);
			const webhook: ApiWebhookRecord = {
				webhookId,
				accountId: principal.accountId,
				url: target.toString(),
				sealedSecret: yield* sealApiString(
					apiWebhookSecretSealContext(principal.accountId, webhookId),
					secret,
				),
				...(description === undefined || description.length === 0
					? {}
					: { description }),
				createdAtMs: nowMs,
			};
			yield* store.createApiWebhook(webhook);
			return json({ webhook: publicWebhook(webhook), secret }, 201);
		}

		if (method === "GET" && path === ApiPaths.apiWebhooks) {
			const webhooks = yield* store.listApiWebhooks(principal.accountId);
			return json({ webhooks: webhooks.map(publicWebhook) });
		}

		const webhookMatch = /^\/v1\/api\/webhooks\/([^/]+)$/u.exec(path);
		if (method === "DELETE" && webhookMatch !== null) {
			const removed = yield* store.deleteApiWebhook(
				principal.accountId,
				decodeURIComponent(webhookMatch[1] ?? ""),
			);
			if (!removed) return yield* Effect.fail(notFound("webhook_not_found"));
			return json({ ok: true });
		}

		return null;
	});
