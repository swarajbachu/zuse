import {
	ApiPaths,
	ApiSendMessageRequest,
	ApiWebhookCreateRequest,
	ApiWorkspaceCreateRequest,
} from "@zuse/contracts";
import { cloudRuntimeCommandTurnId } from "@zuse/utils/cloud-api";
import { Clock, Effect } from "effect";
import {
	API_ASSET_MAX_BYTES,
	API_MESSAGE_MAX_ASSETS,
	getApiAsset,
	putApiAsset,
} from "./api-assets.ts";
import {
	decodeApiMessageContent,
	encodeApiMessageContent,
} from "./api-message-content.ts";
import {
	apiMessageSealContext,
	apiWebhookSecretSealContext,
	digestApiString,
	openApiMessageString,
	sealApiString,
} from "./api-sealing.ts";
import { safeApiWebhookTarget } from "./api-webhook-target.ts";
import { requireApiKey } from "./auth.ts";
import { requireCloudBetaAccess } from "./beta-access.ts";
import {
	type CloudWorkspaceRouteContext,
	cloudWorkspaceResumeIsAlreadyRequested,
	cloudWorkspaceResumeTarget,
	createCloudWorkspaceForAccount,
	requireCloudBillingCapacity,
	requireCloudWorkspaceEntitlement,
	startupPhase,
} from "./cloud-workspace-routes.ts";
import { cloudWorkspaceGatewayEpoch } from "./cloud-workspace-runtime-fence.ts";
import {
	type ApiWebhookRecord,
	type CloudWorkspaceApiMessageRecord,
	type CloudWorkspaceRecord,
	CloudWorkspaceStore,
} from "./cloud-workspace-store.ts";
import { ApiConfiguration } from "./config.ts";
import { randomToken, sha256Hex } from "./crypto.ts";
import {
	type ApiError,
	badRequest,
	conflict,
	notFound,
	serviceUnavailable,
} from "./errors.ts";
import { decodeBody, decodePathSegment, json } from "./http.ts";

// The `/v1/api/**` surface: the machine-caller (API-key) counterpart of the
// first-party `/v1/cloud/**` routes. It exposes only the core loop — create a
// workspace with a prompt, send follow-up messages, poll the conversation
// ledger, manage webhook endpoints — and shares the underlying create/resume
// implementations with the WorkOS surface.

const API_MESSAGE_PAGE_LIMIT = 200;
const API_MESSAGE_EXPIRY_MS = 24 * 60 * 60 * 1_000;
const API_PROMPT_MAX_LENGTH = 65_536;
const API_IDEMPOTENCY_KEY_MAX_LENGTH = 200;
const API_WEBHOOK_LIMIT = 20;
const API_MESSAGE_WORKSPACE_RETRIES = 4;

const requestConfigString = (
	workspace: CloudWorkspaceRecord,
	key: string,
): string | undefined =>
	typeof workspace.requestConfig[key] === "string"
		? (workspace.requestConfig[key] as string)
		: undefined;

const workspaceAcceptsMessages = (workspace: CloudWorkspaceRecord): boolean =>
	!["archiving", "archived", "deleting", "deleted", "failed"].includes(
		workspace.state,
	) && workspace.desiredState !== "deleted";

const workspaceNeedsResume = (workspace: CloudWorkspaceRecord): boolean =>
	workspace.state === "paused" ||
	workspace.state === "pausing" ||
	workspace.desiredState === "paused";

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

const idempotencyKey = (
	bodyValue: string | undefined,
	headerValue: string | undefined,
): Effect.Effect<string | undefined, ApiError> => {
	const body = bodyValue?.trim();
	const header = headerValue?.trim();
	if (body !== undefined && header !== undefined && body !== header)
		return Effect.fail(badRequest("idempotency_key_mismatch"));
	const selected = body ?? header;
	if (
		selected !== undefined &&
		(selected.length === 0 || selected.length > API_IDEMPOTENCY_KEY_MAX_LENGTH)
	)
		return Effect.fail(badRequest("invalid_idempotency_key"));
	return Effect.succeed(selected);
};

const publicApiMessage = Effect.fn("publicApiMessage")(function* (
	message: CloudWorkspaceApiMessageRecord,
) {
	const plaintext = yield* openApiMessageString(
		message.accountId,
		message.workspaceId,
		message.messageId,
		message.sealedContent,
	);
	const content =
		message.role === "user"
			? decodeApiMessageContent(plaintext)
			: { text: plaintext, attachments: [] };
	return {
		messageId: message.messageId,
		seq: message.seq,
		role: message.role,
		text: content.text,
		status: message.status,
		...(message.turnId === undefined ? {} : { turnId: message.turnId }),
		...(message.outcome === undefined ? {} : { outcome: message.outcome }),
		createdAt: message.createdAtMs,
		...(content.attachments.length === 0
			? {}
			: { attachments: content.attachments }),
	};
});

const requireMatchingApiMessage = Effect.fn("requireMatchingApiMessage")(
	function* (message: CloudWorkspaceApiMessageRecord, expected: string) {
		const existing = yield* openApiMessageString(
			message.accountId,
			message.workspaceId,
			message.messageId,
			message.sealedContent,
		);
		if (existing !== expected)
			return yield* Effect.fail(
				conflict("idempotency_key_reused_with_different_request"),
			);
	},
);

const apiWorkspaceStatus = Effect.fn("apiWorkspaceStatus")(function* (
	workspace: CloudWorkspaceRecord,
) {
	const store = yield* CloudWorkspaceStore;
	const summary = yield* store.getApiWorkspaceLedgerSummary(
		workspace.workspaceId,
	);
	const lastAssistant = summary.lastAssistant;
	return {
		workspaceId: workspace.workspaceId,
		projectId: workspace.projectId,
		branch: workspace.branch,
		baseRef: workspace.baseRef,
		state: workspace.state,
		statusCode: workspace.statusCode,
		startupPhase: startupPhase(workspace),
		runtimeState: workspace.runtimeState,
		agentStatus:
			summary.hasOutstanding && workspaceAcceptsMessages(workspace)
				? ("working" as const)
				: lastAssistant !== null
					? ("idle" as const)
					: ("unknown" as const),
		latestSeq: summary.latestSeq,
		lastTurn:
			lastAssistant?.turnId === undefined || lastAssistant.outcome === undefined
				? null
				: {
						turnId: lastAssistant.turnId,
						outcome: lastAssistant.outcome,
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
		if (!new URL(request.url).pathname.startsWith("/v1/api/")) return null;
		const principal = yield* requireApiKey(request);
		return yield* routeAccountWorkspaceRequest(request, principal.accountId);
	});

/** Internal account-scoped entry point. Never accept accountId from HTTP input.
 * Public keys and first-party integrations share the same entitlement, ownership,
 * idempotency, attachment, and lifecycle implementation here.
 */
export const routeAccountWorkspaceRequest = (
	request: Request,
	accountId: string,
	options?: { readonly internalWebhookTarget?: (url: string) => boolean },
): Effect.Effect<Response | null, ApiError, CloudWorkspaceRouteContext> =>
	Effect.gen(function* () {
		const url = new URL(request.url);
		const path = url.pathname;
		const method = request.method.toUpperCase();
		if (!path.startsWith("/v1/api/")) return null;
		const store = yield* CloudWorkspaceStore;
		const config = yield* ApiConfiguration;
		const nowMs = yield* Clock.currentTimeMillis;
		const principal = { accountId };
		const headerIdempotencyKey =
			request.headers.get("idempotency-key") ?? undefined;
		const isCleanupRequest =
			method === "DELETE" && /^\/v1\/api\/webhooks\/[^/]+$/u.test(path);
		if (!isCleanupRequest) {
			yield* requireCloudBetaAccess(principal.accountId);
			yield* requireCloudWorkspaceEntitlement(principal.accountId, nowMs);
		}

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
			const prompt = body.prompt?.trim();
			if (
				prompt !== undefined &&
				(prompt.length === 0 || prompt.length > API_PROMPT_MAX_LENGTH)
			)
				return yield* Effect.fail(badRequest("invalid_prompt"));
			const requestedIdempotencyKey = yield* idempotencyKey(
				body.idempotencyKey,
				headerIdempotencyKey,
			);
			const selectedIdempotencyKey =
				requestedIdempotencyKey ?? (yield* randomToken("apicreate", 16));
			// Fingerprint what the caller supplied, rather than mutable inferred
			// defaults. A later retry must keep resolving to its original receipt even
			// if projects, billing state, or the account's recent workspace changed.
			const requestDigest = yield* digestApiString(
				`workspace-create-receipt\n${principal.accountId}\n${selectedIdempotencyKey}`,
				JSON.stringify({
					prompt,
					projectId: body.projectId ?? null,
					providerId: body.providerId ?? null,
					baseRef: body.baseRef ?? null,
					branch: body.branch ?? null,
					agent: body.agent ?? null,
					model: body.model ?? null,
					// Keep omitted-mode receipts compatible with requests made before
					// API callers could select access. Retries never upgrade old workspaces.
					...(body.runtimeMode === undefined
						? {}
						: { runtimeMode: body.runtimeMode }),
				}),
			);
			const accountWorkspaces = yield* store.listWorkspaces(
				principal.accountId,
			);
			const existingWorkspace =
				requestedIdempotencyKey === undefined
					? undefined
					: accountWorkspaces.find(
							(workspace) =>
								workspace.idempotencyKey === `api:${selectedIdempotencyKey}`,
						);
			let legacyWorkspaceValidated = false;
			if (existingWorkspace !== undefined) {
				const storedDigest = requestConfigString(
					existingWorkspace,
					"publicApiRequestDigest",
				);
				if (storedDigest !== undefined && storedDigest !== requestDigest)
					return yield* Effect.fail(
						conflict("idempotency_key_reused_with_different_request"),
					);
				if (storedDigest === undefined) {
					const legacyPrompt = yield* store.getApiMessage(
						`msg_launch_${existingWorkspace.workspaceId}`,
					);
					const suppliedConfigurationMatches =
						(body.projectId === undefined ||
							body.projectId === existingWorkspace.projectId) &&
						(body.providerId === undefined ||
							body.providerId === existingWorkspace.provider) &&
						(body.baseRef === undefined ||
							body.baseRef === existingWorkspace.baseRef) &&
						(body.branch === undefined ||
							body.branch === existingWorkspace.branch) &&
						(body.agent === undefined ||
							body.agent === requestConfigString(existingWorkspace, "agent")) &&
						(body.model === undefined ||
							body.model === requestConfigString(existingWorkspace, "model")) &&
						(body.runtimeMode === undefined ||
							body.runtimeMode ===
								requestConfigString(existingWorkspace, "runtimeMode"));
					if (
						!suppliedConfigurationMatches ||
						prompt === undefined ||
						legacyPrompt === null ||
						legacyPrompt.workspaceId !== existingWorkspace.workspaceId ||
						legacyPrompt.accountId !== principal.accountId ||
						legacyPrompt.role !== "user" ||
						decodeApiMessageContent(
							yield* openApiMessageString(
								legacyPrompt.accountId,
								legacyPrompt.workspaceId,
								legacyPrompt.messageId,
								legacyPrompt.sealedContent,
							),
						).text !== prompt
					)
						return yield* Effect.fail(
							conflict("idempotency_key_reused_with_different_request"),
						);
					legacyWorkspaceValidated = true;
				}
			}
			let workspace: CloudWorkspaceRecord;
			let created = false;
			if (existingWorkspace !== undefined) {
				workspace = existingWorkspace;
			} else {
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
				const recent = [...accountWorkspaces].sort(
					(a, b) => b.createdAtMs - a.createdAtMs,
				)[0];
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
				const outcome = yield* createCloudWorkspaceForAccount(
					principal.accountId,
					{
						projectId: project.projectId,
						providerId: body.providerId,
						baseRef: body.baseRef ?? project.defaultBranch,
						...(body.branch === undefined ? {} : { branch: body.branch }),
						agent,
						model,
						runtimeMode: body.runtimeMode ?? "full-access",
						...(prompt === undefined
							? {}
							: {
									firstMessage: prompt,
								}),
						idempotencyKey: `api:${selectedIdempotencyKey}`,
						publicApiRequestDigest: requestDigest,
					},
					nowMs,
				);
				workspace = outcome.workspace;
				created = outcome.created;
			}
			if (
				!legacyWorkspaceValidated &&
				requestConfigString(workspace, "publicApiRequestDigest") !==
					requestDigest
			)
				return yield* Effect.fail(
					conflict("idempotency_key_reused_with_different_request"),
				);
			// Mirror the launch prompt into the conversation ledger so polling
			// clients see the full exchange. The launch intent itself delivers the
			// prompt; the ledger row is settled by the first turn event.
			if (prompt !== undefined) {
				const sealedPrompt = yield* sealApiString(
					apiMessageSealContext(
						principal.accountId,
						workspace.workspaceId,
						`msg_launch_${workspace.workspaceId}`,
					),
					encodeApiMessageContent({ text: prompt, attachments: [] }),
				);
				yield* store.appendApiMessage({
					messageId: `msg_launch_${workspace.workspaceId}`,
					workspaceId: workspace.workspaceId,
					accountId: principal.accountId,
					role: "user",
					sealedContent: sealedPrompt,
					commandId: `launch:${workspace.workspaceId}`,
					turnId: requestConfigString(workspace, "initialTurnId"),
					status: "delivered",
					createdAtMs: nowMs,
				});
			}
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
			const statuses = yield* Effect.forEach(
				visible,
				(workspace) => apiWorkspaceStatus(workspace),
				{ concurrency: 8 },
			);
			return json({ workspaces: statuses });
		}

		const workspaceMatch = /^\/v1\/api\/workspaces\/([^/]+)$/u.exec(path);
		const messagesMatch = /^\/v1\/api\/workspaces\/([^/]+)\/messages$/u.exec(
			path,
		);
		const assetsMatch = /^\/v1\/api\/workspaces\/([^/]+)\/attachments$/u.exec(
			path,
		);
		if (
			workspaceMatch !== null ||
			messagesMatch !== null ||
			assetsMatch !== null
		) {
			const workspaceId = yield* decodePathSegment(
				workspaceMatch?.[1] ?? messagesMatch?.[1] ?? assetsMatch?.[1] ?? "",
			);
			const workspace = yield* store.getWorkspace(workspaceId);
			if (
				workspace === null ||
				workspace.accountId !== principal.accountId ||
				workspace.state === "deleted"
			)
				return yield* Effect.fail(notFound("cloud_workspace_not_found"));

			if (method === "GET" && workspaceMatch !== null)
				return json({ workspace: yield* apiWorkspaceStatus(workspace) });

			if (method === "POST" && assetsMatch !== null) {
				if (!workspaceAcceptsMessages(workspace))
					return yield* Effect.fail(
						conflict("workspace_not_accepting_messages"),
					);
				const declaredLength = Number(
					request.headers.get("content-length") ?? "0",
				);
				if (
					Number.isFinite(declaredLength) &&
					declaredLength > API_ASSET_MAX_BYTES
				)
					return yield* Effect.fail(badRequest("invalid_asset_size"));
				const bytes = yield* Effect.tryPromise({
					try: async () => new Uint8Array(await request.arrayBuffer()),
					catch: () => badRequest("invalid_asset_body"),
				});
				const asset = yield* putApiAsset({
					accountId: principal.accountId,
					workspaceId,
					mimeType: request.headers.get("content-type") ?? "",
					originalName: request.headers.get("x-zuse-file-name") ?? "attachment",
					bytes,
					idempotencyKey: headerIdempotencyKey,
					nowMs,
				});
				return json({ asset }, 201);
			}

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
				const body = yield* decodeBody(ApiSendMessageRequest, request);
				const text = body.text.trim();
				const assetIds = [...new Set(body.attachments ?? [])];
				if (
					(text.length === 0 && assetIds.length === 0) ||
					text.length > API_PROMPT_MAX_LENGTH ||
					assetIds.length > API_MESSAGE_MAX_ASSETS
				)
					return yield* Effect.fail(badRequest("invalid_message"));
				const attachments = yield* Effect.forEach(
					assetIds,
					(assetId) =>
						getApiAsset(principal.accountId, workspaceId, assetId).pipe(
							Effect.flatMap((asset) =>
								asset === null
									? Effect.fail(notFound("api_asset_not_found"))
									: Effect.succeed(asset.asset),
							),
						),
					{ concurrency: 4 },
				);
				const messageContent = encodeApiMessageContent({ text, attachments });
				const selectedIdempotencyKey = yield* idempotencyKey(
					body.idempotencyKey,
					headerIdempotencyKey,
				);
				const messageId = yield* idempotentMessageId(
					principal.accountId,
					workspaceId,
					selectedIdempotencyKey,
				);
				const turnId = cloudRuntimeCommandTurnId(messageId);
				const prior = yield* store.getApiMessage(messageId);
				if (prior !== null) {
					if (
						prior.accountId !== principal.accountId ||
						prior.workspaceId !== workspaceId
					)
						return yield* Effect.fail(conflict("idempotency_key_reused"));
					yield* requireMatchingApiMessage(prior, messageContent);
					if (prior.status === "expired" || prior.status === "failed")
						return yield* Effect.fail(conflict("message_not_deliverable"));
					if (prior.status === "delivered" || prior.status === "settled")
						return json({
							messageId: prior.messageId,
							seq: prior.seq,
							status: "delivered",
							resumeTriggered: false,
						});
				}
				if (!workspaceAcceptsMessages(workspace))
					return yield* Effect.fail(
						conflict("workspace_not_accepting_messages"),
					);
				// Authorization is a precondition for the durable command. A denied
				// request must never leave a row that can execute on a later wake.
				yield* requireCloudBillingCapacity(principal.accountId, nowMs);
				const sealed = yield* sealApiString(
					apiMessageSealContext(principal.accountId, workspaceId, messageId),
					messageContent,
				);
				const message = {
					messageId,
					workspaceId,
					accountId: principal.accountId,
					role: "user",
					sealedContent: sealed,
					commandId: `api:${messageId}`,
					turnId,
					status: "pending",
					createdAtMs: nowMs,
					expiresAtMs: nowMs + API_MESSAGE_EXPIRY_MS,
				} as const;
				let candidate = workspace;
				for (
					let attempt = 0;
					attempt < API_MESSAGE_WORKSPACE_RETRIES;
					attempt += 1
				) {
					if (
						candidate.accountId !== principal.accountId ||
						!workspaceAcceptsMessages(candidate)
					)
						return yield* Effect.fail(
							conflict("workspace_not_accepting_messages"),
						);
					const needsResume = workspaceNeedsResume(candidate);
					const resumeRequired =
						needsResume && !cloudWorkspaceResumeIsAlreadyRequested(candidate);
					const committed = yield* store.appendApiMessageGuarded({
						message,
						expectedWorkspace: candidate,
						...(resumeRequired
							? {
									lifecycleCommand: {
										workspace: cloudWorkspaceResumeTarget(candidate, nowMs),
										commandId: `api-resume:${messageId}:${candidate.revision}`,
										action: "resume",
										createdAtMs: nowMs,
									},
								}
							: {}),
					});
					if (committed.kind === "workspace-contended") {
						if (committed.workspace === null)
							return yield* Effect.fail(notFound("cloud_workspace_not_found"));
						candidate = committed.workspace;
						continue;
					}
					const appended = committed.append;
					if (appended.kind === "existing")
						yield* requireMatchingApiMessage(appended.message, messageContent);
					if (
						appended.message.status === "expired" ||
						appended.message.status === "failed"
					)
						return yield* Effect.fail(conflict("message_not_deliverable"));
					const shouldDeliver = appended.message.status === "pending";
					const response = json({
						messageId: appended.message.messageId,
						seq: appended.message.seq,
						status:
							appended.message.status === "pending" ? "queued" : "delivered",
						resumeTriggered: committed.lifecycleCommandSaved,
					});
					if (needsResume && shouldDeliver) {
						response.headers.set(
							"x-zuse-reconcile-cloud-workspace",
							workspaceId,
						);
					} else if (
						shouldDeliver &&
						committed.workspace.runtimeState === "online"
					) {
						response.headers.set(
							"x-zuse-nudge-cloud-workspace",
							`${workspaceId}:${cloudWorkspaceGatewayEpoch(committed.workspace)}`,
						);
					}
					return response;
				}
				return yield* Effect.fail(
					serviceUnavailable("cloud_workspace_state_contended"),
				);
			}
		}

		if (method === "POST" && path === ApiPaths.apiWebhooks) {
			const body = yield* decodeBody(ApiWebhookCreateRequest, request);
			const target = options?.internalWebhookTarget?.(body.url)
				? new URL(body.url)
				: safeApiWebhookTarget(body.url, config.apiIssuer);
			if (target === null)
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
			if (!(yield* store.createApiWebhook(webhook, API_WEBHOOK_LIMIT)))
				return yield* Effect.fail(conflict("webhook_limit_reached"));
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
				yield* decodePathSegment(webhookMatch[1] ?? ""),
			);
			if (!removed) return yield* Effect.fail(notFound("webhook_not_found"));
			return json({ ok: true });
		}

		return null;
	});
