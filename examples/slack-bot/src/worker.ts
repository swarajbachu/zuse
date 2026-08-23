// Reference Slack app for Zuse Cloud Workspaces.
//
//   /zuse <prompt>          → starts a cloud workspace, posts a channel message
//   reply in that thread    → forwarded as a follow-up message to the agent
//   Zuse webhook delivery   → agent replies posted back into the thread
//
// The bot deliberately uses only the public API (`zk_` key + signed webhooks),
// never first-party API auth — it is the integration model, not a shortcut.

import {
	postSlackMessage,
	verifySlackSignature,
	verifyZuseSignature,
} from "./slack.ts";
import { createWorkspace, sendMessage, type ZuseClientConfig } from "./zuse.ts";

interface KvNamespace {
	readonly get: (key: string) => Promise<string | null>;
	readonly put: (
		key: string,
		value: string,
		options?: { readonly expirationTtl?: number },
	) => Promise<void>;
}

interface Env {
	readonly THREADS: KvNamespace;
	readonly ZUSE_API_URL: string;
	readonly SLACK_SIGNING_SECRET: string;
	readonly SLACK_BOT_TOKEN: string;
	readonly ZUSE_API_KEY: string;
	readonly ZUSE_WEBHOOK_SECRET: string;
}

interface ExecutionContext {
	readonly waitUntil: (promise: Promise<unknown>) => void;
}

/** Thread mappings outlive any realistic workspace by a wide margin. */
const MAPPING_TTL_SECONDS = 30 * 24 * 60 * 60;

const zuseConfig = (env: Env): ZuseClientConfig => ({
	apiUrl: env.ZUSE_API_URL,
	apiKey: env.ZUSE_API_KEY,
});

const startWorkspaceFromCommand = async (
	env: Env,
	command: {
		readonly prompt: string;
		readonly channel: string;
		readonly triggerId: string;
		readonly responseUrl: string;
	},
): Promise<void> => {
	try {
		const { workspace } = await createWorkspace(zuseConfig(env), {
			prompt: command.prompt,
			idempotencyKey: `slack:${command.triggerId}`,
		});
		const posted = await postSlackMessage({
			botToken: env.SLACK_BOT_TOKEN,
			channel: command.channel,
			text: `Started cloud workspace \`${workspace.branch}\` — the agent's replies will appear in this thread. Reply here to send follow-ups.`,
		});
		if (posted.ts !== null) {
			await env.THREADS.put(
				`workspace:${workspace.workspaceId}`,
				JSON.stringify({ channel: command.channel, threadTs: posted.ts }),
				{ expirationTtl: MAPPING_TTL_SECONDS },
			);
			await env.THREADS.put(
				`thread:${command.channel}:${posted.ts}`,
				workspace.workspaceId,
				{ expirationTtl: MAPPING_TTL_SECONDS },
			);
		}
	} catch (error) {
		await fetch(command.responseUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				response_type: "ephemeral",
				text: `The workspace could not be started: ${error instanceof Error ? error.message : "unknown error"}`,
			}),
		});
	}
};

const handleSlashCommand = async (
	request: Request,
	env: Env,
	context: ExecutionContext,
): Promise<Response> => {
	const rawBody = await request.text();
	const valid = await verifySlackSignature({
		signingSecret: env.SLACK_SIGNING_SECRET,
		timestampHeader: request.headers.get("x-slack-request-timestamp"),
		signatureHeader: request.headers.get("x-slack-signature"),
		rawBody,
	});
	if (!valid) return new Response("invalid signature", { status: 401 });
	const form = new URLSearchParams(rawBody);
	const prompt = (form.get("text") ?? "").trim();
	if (prompt.length === 0)
		return Response.json({
			response_type: "ephemeral",
			text: "Usage: /zuse <what the agent should do>",
		});
	context.waitUntil(
		startWorkspaceFromCommand(env, {
			prompt,
			channel: form.get("channel_id") ?? "",
			triggerId: form.get("trigger_id") ?? crypto.randomUUID(),
			responseUrl: form.get("response_url") ?? "",
		}),
	);
	// Slack requires an acknowledgement within three seconds.
	return Response.json({
		response_type: "in_channel",
		text: "Starting a Zuse cloud workspace…",
	});
};

const handleSlackEvent = async (
	request: Request,
	env: Env,
	context: ExecutionContext,
): Promise<Response> => {
	const rawBody = await request.text();
	const valid = await verifySlackSignature({
		signingSecret: env.SLACK_SIGNING_SECRET,
		timestampHeader: request.headers.get("x-slack-request-timestamp"),
		signatureHeader: request.headers.get("x-slack-signature"),
		rawBody,
	});
	if (!valid) return new Response("invalid signature", { status: 401 });
	const payload = JSON.parse(rawBody) as {
		readonly type?: string;
		readonly challenge?: string;
		readonly event_id?: string;
		readonly event?: {
			readonly type?: string;
			readonly channel?: string;
			readonly thread_ts?: string;
			readonly text?: string;
			readonly bot_id?: string;
			readonly subtype?: string;
		};
	};
	if (payload.type === "url_verification")
		return Response.json({ challenge: payload.challenge ?? "" });
	const event = payload.event;
	if (
		payload.type === "event_callback" &&
		event?.type === "message" &&
		event.bot_id === undefined &&
		event.subtype === undefined &&
		event.channel !== undefined &&
		event.thread_ts !== undefined &&
		event.text !== undefined &&
		event.text.trim().length > 0
	) {
		const { channel, thread_ts: threadTs } = event;
		const text = event.text.trim();
		const eventId = payload.event_id ?? crypto.randomUUID();
		context.waitUntil(
			(async () => {
				const workspaceId = await env.THREADS.get(
					`thread:${channel}:${threadTs}`,
				);
				if (workspaceId === null) return;
				await sendMessage(zuseConfig(env), {
					workspaceId,
					text,
					idempotencyKey: `slack-event:${eventId}`,
				});
			})(),
		);
	}
	return new Response("ok");
};

const handleZuseWebhook = async (
	request: Request,
	env: Env,
	context: ExecutionContext,
): Promise<Response> => {
	const rawBody = await request.text();
	const valid = await verifyZuseSignature({
		secret: env.ZUSE_WEBHOOK_SECRET,
		signatureHeader: request.headers.get("zuse-signature"),
		rawBody,
	});
	if (!valid) return new Response("invalid signature", { status: 401 });
	const event = JSON.parse(rawBody) as {
		readonly eventId?: string;
		readonly type?: string;
		readonly workspaceId?: string;
		readonly outcome?: string;
		readonly reply?: { readonly text?: string; readonly truncated?: boolean };
	};
	if (
		event.type !== "workspace.turn.completed" ||
		event.workspaceId === undefined ||
		event.eventId === undefined
	)
		return new Response("ok");
	const dedupeKey = `event:${event.eventId}`;
	if ((await env.THREADS.get(dedupeKey)) !== null) return new Response("ok");
	await env.THREADS.put(dedupeKey, "1", { expirationTtl: 24 * 60 * 60 });
	const mapping = await env.THREADS.get(`workspace:${event.workspaceId}`);
	if (mapping === null) return new Response("ok");
	const { channel, threadTs } = JSON.parse(mapping) as {
		readonly channel: string;
		readonly threadTs: string;
	};
	const replyText = event.reply?.text?.trim();
	const text =
		replyText === undefined || replyText.length === 0
			? `The agent finished this turn (${event.outcome ?? "completed"}).`
			: `${replyText}${event.reply?.truncated === true ? "\n_(reply truncated)_" : ""}`;
	context.waitUntil(
		postSlackMessage({
			botToken: env.SLACK_BOT_TOKEN,
			channel,
			threadTs,
			text,
		}),
	);
	return new Response("ok");
};

export default {
	async fetch(
		request: Request,
		env: Env,
		context: ExecutionContext,
	): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path === "/slack/commands")
			return handleSlashCommand(request, env, context);
		if (request.method === "POST" && path === "/slack/events")
			return handleSlackEvent(request, env, context);
		if (request.method === "POST" && path === "/zuse/webhook")
			return handleZuseWebhook(request, env, context);
		return new Response("not found", { status: 404 });
	},
};
