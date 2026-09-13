import { executionAccount } from "./access.ts";
import { accountRoutes, notifyConnected } from "./accounts.ts";
import { matchAlert, type SlackMessageEvent } from "./automation.ts";
import {
	isConversationEvent,
	pollProgress,
	runConversation,
} from "./conversation.ts";
import { errorDiagnostics } from "./diagnostics.ts";
import { reportJobFailure } from "./failures.ts";
import {
	disconnectMember,
	publishHome,
	selectProject,
	selectReplyMode,
} from "./home.ts";
import { interactions } from "./interactions.ts";
import {
	acceptRepository,
	loadRepositoryView,
	promptRepository,
} from "./repositories.ts";
import { handleZuseWebhook, runAutomation, runnerEnv } from "./runner.ts";
import { oauth, settings, storeFor } from "./setup.ts";
import {
	SlackApiError,
	SlackRateLimitError,
	verifySlackSignature,
} from "./slack.ts";
import { retryStatusClear } from "./thread-status.ts";
import type { AppEnv, AppJob, QueueMessage } from "./types.ts";
import { page } from "./web.ts";
import { slackWebhookLocation } from "./webhook-target.ts";
import { deleteWebhook, ZuseApiError } from "./zuse.ts";

interface Context {
	waitUntil(promise: Promise<unknown>): void;
}

const boundedBody = async (request: Request): Promise<string> => {
	const reader = request.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let body = "";
	let bytes = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			bytes += chunk.value.byteLength;
			if (bytes > 256_000) {
				await reader.cancel();
				throw new Error("request_too_large");
			}
			body += decoder.decode(chunk.value, { stream: true });
		}
		return body + decoder.decode();
	} finally {
		reader.releaseLock();
	}
};

const events = async (
	request: Request,
	env: AppEnv,
	context: Context,
): Promise<Response> => {
	const rawBody = await request.text();
	if (
		!(await verifySlackSignature({
			signingSecret: env.SLACK_SIGNING_SECRET,
			timestampHeader: request.headers.get("x-slack-request-timestamp"),
			signatureHeader: request.headers.get("x-slack-signature"),
			rawBody,
		}))
	)
		return new Response("invalid signature", { status: 401 });
	let payload: {
		type?: string;
		challenge?: string;
		api_app_id?: string;
		team_id?: string;
		event_id?: string;
		is_ext_shared_channel?: boolean;
		event?: SlackMessageEvent & {
			user?: string;
			tab?: string;
			thread_ts?: string;
			tokens?: { oauth?: string[]; bot?: string[] };
		};
	};
	try {
		payload = JSON.parse(rawBody);
		if (!payload || typeof payload !== "object") throw new Error();
	} catch {
		return new Response("invalid event", { status: 400 });
	}
	if (payload.type === "url_verification")
		return Response.json({ challenge: payload.challenge ?? "" });
	if (
		payload.api_app_id !== env.SLACK_APP_ID ||
		!payload.team_id ||
		!/^T[A-Z0-9]+$/u.test(payload.team_id)
	)
		return new Response("invalid installation", { status: 403 });
	const store = storeFor(env);
	const installation = await store.get(payload.team_id);
	if (!installation || payload.type !== "event_callback" || !payload.event)
		return new Response("ok");
	const event = payload.event;
	if (
		event.type === "app_uninstalled" ||
		(event.type === "tokens_revoked" &&
			(event.tokens?.oauth?.includes(installation.ownerId) ||
				event.tokens?.bot?.includes(installation.credentials.botUserId)))
	) {
		await store.remove(installation);
		const zuse = installation.credentials.zuse;
		// Local credentials and sessions are removed before acknowledgement.
		// Subscription cleanup is best effort after local access is removed.
		if (zuse)
			context.waitUntil(
				deleteWebhook(env.cloud(zuse.accountId), zuse.webhookId).catch(() =>
					console.error("[slack-app] remote webhook cleanup failed", {
						teamId: installation.teamId,
					}),
				),
			);
		return new Response("ok");
	}
	if (!payload.event_id)
		return new Response("missing event id", { status: 400 });
	let job: AppJob | undefined;
	const identity = {
		teamId: installation.teamId,
		generation: installation.generation,
		id: payload.event_id,
	};
	if (event.type === "app_home_opened" && event.user && event.tab === "home")
		job = { ...identity, kind: "home", userId: event.user };
	else if (!payload.is_ext_shared_channel && event.channel && event.ts) {
		const active =
			event.user && !event.bot_id
				? await executionAccount(env, installation, event.user)
				: null;
		const knownThread =
			event.type === "message" &&
			event.thread_ts &&
			event.user &&
			!event.bot_id &&
			(!event.subtype || event.subtype === "file_share") &&
			event.user !== installation.credentials.botUserId &&
			active &&
			(await env.store.member(installation, event.user)).defaults.replyMode ===
				"all"
				? await runnerEnv(env, installation, active.connection).THREADS.get(
						`thread:${event.channel}:${event.thread_ts}`,
					)
				: null;
		if (
			event.user &&
			(isConversationEvent(event, installation.credentials.botUserId) ||
				knownThread)
		) {
			job = {
				...identity,
				kind: "conversation",
				userId: event.user,
				channel: event.channel,
				threadTs: event.thread_ts ?? event.ts,
				messageTs: event.ts,
				text: event.text ?? "",
				revision: installation.revision,
				connectionId: active?.connection.webhookId,
				files: event.files,
			};
		} else {
			const rule = matchAlert(installation.credentials.rules, event);
			const ownerConnection = rule
				? (await env.store.member(installation, installation.ownerId))
						.connection
				: null;
			if (rule && ownerConnection)
				job = {
					...identity,
					kind: "alert",
					connectionId: ownerConnection.webhookId,
					id: `alert:${rule.id}:${rule.mode}:${event.channel}:${event.ts}`,
					revision: installation.revision,
					ruleId: rule.id,
					channel: event.channel,
					threadTs: event.ts,
				};
		}
	}
	if (job) await env.JOBS.send(job);
	return new Response("ok");
};

export default {
	async fetch(
		incoming: Request,
		env: AppEnv,
		context: Context,
	): Promise<Response> {
		const path = new URL(incoming.url).pathname;
		try {
			let request = incoming;
			if (incoming.method === "POST") {
				let body: string;
				try {
					body = await boundedBody(incoming);
				} catch {
					return new Response("request too large", { status: 413 });
				}
				request = new Request(incoming.url, {
					method: incoming.method,
					headers: incoming.headers,
					body,
				});
			}
			if (request.method === "GET" && (path === "/slack" || path === "/slack/"))
				return page(
					`<h1>Zuse for Slack</h1><p>Connect your workspace, configure automations, and receive agent results where the work starts.</p><a href="/slack/install">Add to Slack</a>`,
				);
			const setupResponse =
				(await oauth(request, env)) ??
				(await accountRoutes(request, env)) ??
				(await settings(request, env));
			if (setupResponse) return setupResponse;
			if (request.method === "POST" && path === "/slack/events")
				return await events(request, env, context);
			if (request.method === "POST" && path === "/slack/interactions")
				return await interactions(request, env);
			const webhook = slackWebhookLocation(path);
			if (request.method === "POST" && webhook) {
				const installation = await storeFor(env).get(webhook[1] ?? "");
				if (!installation || installation.generation !== webhook[2])
					return new Response("installation not found", { status: 404 });
				const connection = (
					await env.store.member(
						installation,
						webhook[3] ?? installation.ownerId,
					)
				).connection;
				if (!connection)
					return new Response("connection not found", { status: 404 });
				return await handleZuseWebhook(
					request,
					runnerEnv(env, installation, connection),
				);
			}
			return new Response("not found", { status: 404 });
		} catch (error) {
			console.error("[slack-app] request failed", {
				path: path.startsWith("/slack/setup/")
					? "/slack/setup"
					: path.startsWith("/slack/webhook/")
						? "/slack/webhook"
						: path,
				...errorDiagnostics(error),
			});
			return new Response("Request failed. Retry or reopen Zuse's App Home.", {
				status: 503,
			});
		}
	},
	async queue(
		batch: { readonly messages: ReadonlyArray<QueueMessage> },
		env: AppEnv,
	): Promise<void> {
		for (const message of batch.messages) {
			const job = message.body;
			try {
				const installation = await storeFor(env).get(job.teamId);
				if (!installation || installation.generation !== job.generation) {
					message.ack();
					continue;
				}
				if (job.kind === "status-clear")
					await retryStatusClear(env, installation, job);
				else if (job.kind === "home")
					await publishHome(env, installation, job.userId);
				else if (job.kind === "connected") {
					await notifyConnected(env, installation, job);
					await publishHome(env, installation, job.userId);
				} else if (job.kind === "agent-required") {
					const state = env.store.state(installation);
					const key = `notice:${job.id}`;
					if (job.request.connectionId && !(await state.get(key))) {
						await promptRepository(
							env,
							installation,
							job.request,
							job.request.connectionId,
							{
								needsAgent: true,
								announcement:
									"Choose an agent and model to continue your original request. Your repository and attachments are saved.",
							},
						);
						await state.put(key, "1", { expirationTtl: 86400 });
					}
				} else if (job.kind === "disconnect")
					await disconnectMember(
						env,
						installation,
						job.userId,
						job.connectionId,
					);
				else if (job.kind === "policy") {
					if (
						job.userId === installation.ownerId &&
						job.revision === installation.revision &&
						(job.mode !== "shared" ||
							(await env.store.member(installation, job.userId)).connection)
					)
						await env.store.save(installation, {
							...installation.credentials,
							accessMode: job.mode,
						});
					const current = await env.store.get(job.teamId);
					if (current?.generation === job.generation)
						await publishHome(env, current, job.userId);
				} else if (job.kind === "picker")
					await loadRepositoryView(env, installation, job);
				else if (job.kind === "selection") {
					const conversation = await acceptRepository(env, installation, job);
					if (conversation)
						await runConversation(env, installation, conversation);
				} else if (job.kind === "reply-mode")
					await selectReplyMode(
						env,
						installation,
						job.userId,
						job.mode,
						job.memberRevision,
					);
				else if (job.kind === "project")
					await selectProject(
						env,
						installation,
						job.projectId,
						job.userId,
						job.revision,
						job.memberRevision,
					);
				else if (job.kind === "conversation")
					await runConversation(env, installation, job);
				else if (job.kind === "progress") {
					const state = env.store.state(installation);
					const key = `poll:${job.id}`;
					if (!(await state.get(key))) {
						await pollProgress(env, installation, job);
						await state.put(key, "1", { expirationTtl: 86400 });
					}
				} else {
					const ownerConnection = (
						await env.store.member(installation, installation.ownerId)
					).connection;
					// A settings change disables old queued work, including dry-run → live.
					const rule = installation.credentials.rules.find(
						(candidate) =>
							candidate.id === job.ruleId &&
							candidate.channelId === job.channel,
					);
					if (
						!ownerConnection ||
						ownerConnection.webhookId !==
							(job.connectionId ?? installation.credentials.zuse?.webhookId) ||
						!rule ||
						installation.revision !== job.revision
					) {
						message.ack();
						continue;
					}
					const scoped = runnerEnv(env, installation, ownerConnection);
					const dedupeKey = `job:${job.id}`;
					if (!(await scoped.THREADS.get(dedupeKey))) {
						await runAutomation(scoped, job, rule);
						await scoped.THREADS.put(dedupeKey, "1", { expirationTtl: 86400 });
					}
				}
				message.ack();
			} catch (error) {
				const permanent =
					(error instanceof SlackApiError || error instanceof ZuseApiError) &&
					!error.retryable;
				console.error("[slack-app] job failed", {
					teamId: job.teamId,
					jobId: job.id,
					attempts: message.attempts,
					kind: job.kind,
					...errorDiagnostics(error),
				});
				if (job.kind === "picker" || message.attempts >= 6 || permanent) {
					try {
						await reportJobFailure(env, job, error, permanent);
					} catch (notificationError) {
						console.error(
							"[slack-app] failure notification failed",
							errorDiagnostics(notificationError),
						);
						message.retry({
							delaySeconds:
								notificationError instanceof SlackRateLimitError
									? notificationError.retryAfterSeconds
									: Math.min(300, 10 * 2 ** (message.attempts - 1)),
						});
						continue;
					}
				}
				if (permanent) {
					message.ack();
					continue;
				}
				message.retry({
					delaySeconds:
						error instanceof SlackRateLimitError
							? error.retryAfterSeconds
							: Math.min(300, 10 * 2 ** (message.attempts - 1)),
				});
			}
		}
	},
};
