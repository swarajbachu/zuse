import { executionAccount } from "./access.ts";
import type { Installation } from "./installations.ts";
import { randomSecret } from "./installations.ts";
import { promptRepository } from "./repositories.ts";
import { slackApi } from "./slack.ts";
import type { AppEnv, AppJob, PendingConnectionRequest } from "./types.ts";
import {
	appOrigin,
	cookie,
	htmlEscape,
	page,
	readCookie,
	redirect,
	SLACK_PAGE_HEADERS,
} from "./web.ts";
import { deleteWebhook, registerWebhook } from "./zuse.ts";

export const slackHomeUrl = (env: AppEnv, installation: Installation) =>
	`slack://app?team=${installation.teamId}&id=${env.SLACK_APP_ID}&tab=home`;
export const successPage = async (
	env: AppEnv,
	installation: Installation,
	connected: boolean,
	userId?: string,
) => {
	const profile =
		connected && userId ? await env.store.member(installation, userId) : null;
	const csrf = randomSecret();
	const token =
		profile?.connection && userId
			? await env.store.session(
					"settings",
					installation,
					JSON.stringify({
						purpose: "member-account",
						connectionId: profile.connection.webhookId,
						csrf,
					}),
					userId,
				)
			: undefined;
	const html = renderIntegrationPage({
		integration: "Slack",
		description: connected
			? "Your Zuse account is connected. Choose your repository and agent in Slack."
			: "Zuse is installed. Return to Slack and connect your account privately.",
		status: connected ? "Connected" : "Installed",
		hint: token
			? "Log out to connect a different Zuse account. This disconnects your Slack link and clears its repository defaults, including access for teammates using your shared account. Running work is not cancelled. Other Zuse sessions stay signed in."
			: "Account sharing and repository defaults are managed in Zuse’s Home tab.",
		actions: [
			{ label: "Return to Slack", href: slackHomeUrl(env, installation) },
			...(token
				? [
						{
							label: "Log out of Slack connection",
							action: "/slack/account/logout",
							csrf,
						},
					]
				: []),
		],
	});
	const response = new Response(html, { headers: SLACK_PAGE_HEADERS });
	if (token)
		response.headers.append(
			"set-cookie",
			cookie("__Host-zuse-slack-member", token, 3600),
		);
	return response;
};

export const connectUrl = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	channel?: string,
	pendingRequest?: PendingConnectionRequest,
) => {
	const token = await env.store.session(
		"login",
		installation,
		JSON.stringify({ channel, pendingRequest }),
		userId,
	);
	return `${appOrigin(env)}/slack/account/connect?token=${token}`;
};
export const promptConnection = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	channel: string,
	job?: Extract<AppJob, { kind: "conversation" }>,
) => {
	const url = await connectUrl(
		env,
		installation,
		userId,
		channel,
		job ? { job, expiresAt: Date.now() + 3600_000 } : undefined,
	);
	await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
		channel,
		user: userId,
		text: "Connect your Zuse account to work on this request. Only you can see this.",
		blocks: [
			{
				type: "section",
				text: {
					type: "mrkdwn",
					text: "*Connect your Zuse account*\nConnect once to work on your repositories from Slack. Your account stays private unless you explicitly enable sharing.",
				},
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: { type: "plain_text", text: "Connect Zuse account" },
						style: "primary",
						url,
						action_id: "connect_account",
					},
				],
			},
			{
				type: "context",
				elements: [
					{
						type: "plain_text",
						text: "Only you can see this. You can disconnect from Zuse’s Home tab at any time.",
					},
				],
			},
		],
	});
};

const beginSignIn = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	channel?: string,
	pendingRequest?: PendingConnectionRequest,
) => {
	const profile = await env.store.member(installation, userId);
	if (profile.connection)
		return connectionComplete(
			env,
			installation,
			userId,
			profile.connection.webhookId,
			channel,
			pendingRequest,
		);
	const verifier = randomSecret();
	const state = await env.store.session(
		"workos",
		installation,
		JSON.stringify({
			verifier,
			revision: profile.revision,
			channel,
			pendingRequest,
		}),
		userId,
	);
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(verifier),
	);
	const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
	const target = new URL("https://api.workos.com/user_management/authorize");
	target.search = new URLSearchParams({
		client_id: env.identity.clientId,
		provider: "authkit",
		response_type: "code",
		redirect_uri: `${appOrigin(env)}/slack/auth/callback`,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state,
		// Every new Slack account connection must offer fresh authentication,
		// regardless of whether disconnect happened in the browser or App Home.
		prompt: "login",
		max_age: "0",
		screen_hint: "sign-in",
	}).toString();
	return redirect(
		target.toString(),
		cookie("__Host-zuse-slack-account", state, 600),
	);
};

export const accountRoutes = async (
	request: Request,
	env: AppEnv,
): Promise<Response | null> => {
	const url = new URL(request.url);
	if (url.pathname === "/slack/account/logout") {
		if (request.method !== "POST")
			return new Response("Method not allowed", {
				status: 405,
				headers: { allow: "POST" },
			});
		if (request.headers.get("origin") !== appOrigin(env))
			return new Response("invalid origin", { status: 403 });
		const token = readCookie(request, "__Host-zuse-slack-member");
		const session = await env.store.authenticate(token, "settings");
		const installation = session ? await env.store.get(session.team_id) : null;
		if (
			!session ||
			!installation ||
			installation.generation !== session.generation
		)
			return page(
				"<h1>Session expired</h1><p>Open Zuse’s Home tab in Slack to disconnect or reconnect your account.</p>",
				401,
			);
		const payload = JSON.parse(session.payload || "{}");
		const form = await request.formData();
		if (
			payload.purpose !== "member-account" ||
			typeof payload.csrf !== "string" ||
			form.get("csrf") !== payload.csrf
		)
			return new Response("invalid request", { status: 403 });
		const profile = await env.store.member(installation, session.owner_id);
		if (
			!profile.connection ||
			profile.connection.webhookId !== payload.connectionId
		)
			return page(
				"<h1>Connection changed</h1><p>This page belongs to an earlier connection. Open Zuse’s Home tab to manage your current account.</p>",
				409,
			);
		if (!(await env.store.authenticate(token, "settings", true)))
			return new Response("expired session", { status: 401 });
		await disconnectMember(
			env,
			installation,
			session.owner_id,
			payload.connectionId,
			{ notify: false },
		);
		if ((await env.store.member(installation, session.owner_id)).connection)
			return page(
				"<h1>Connection changed</h1><p>Open Zuse’s Home tab to manage your current account.</p>",
				409,
			);
		const login = await env.store.session(
			"login",
			installation,
			"",
			session.owner_id,
		);
		const response = new Response(
			renderIntegrationPage({
				integration: "Slack",
				description: "Your Zuse account is disconnected from Slack.",
				status: "Logged out",
				hint: "Sign in with another Zuse account, then send a new request in Slack. Agent provider credentials must be connected in that account separately.",
				actions: [
					{
						label: "Sign in with another account",
						href: `${appOrigin(env)}/slack/account/connect?token=${login}`,
					},
					{ label: "Return to Slack", href: slackHomeUrl(env, installation) },
				],
			}),
			{ headers: SLACK_PAGE_HEADERS },
		);
		response.headers.append(
			"set-cookie",
			cookie("__Host-zuse-slack-member", "", 0),
		);
		return response;
	}
	if (request.method === "GET" && url.pathname === "/slack/account/connect") {
		const login = await env.store.authenticate(
			url.searchParams.get("token") ?? "",
			"login",
			true,
		);
		const installation = login ? await env.store.get(login.team_id) : null;
		if (!login || !installation || installation.generation !== login.generation)
			return page(
				"<h1>Connection link expired</h1><p>Reopen Zuse’s Home tab or mention Zuse for a new private connection button.</p>",
				401,
			);
		const { channel, pendingRequest } = JSON.parse(login.payload || "{}");
		return beginSignIn(
			env,
			installation,
			login.owner_id,
			channel,
			pendingRequest,
		);
	}
	// Compatibility with already-issued installer setup sessions. No raw model/agent form.
	if (
		(url.pathname === "/slack/setup" && request.method === "GET") ||
		(url.pathname === "/slack/setup/connect" && request.method === "POST")
	) {
		const session = await env.store.authenticate(
			readCookie(request, "__Host-zuse-slack-setup"),
			"settings",
		);
		const installation = session ? await env.store.get(session.team_id) : null;
		if (
			!session ||
			!installation ||
			installation.generation !== session.generation
		)
			return page(
				"<h1>Connect from Slack</h1><p>Open Zuse’s Home tab for your private Connect Zuse button.</p>",
				401,
			);
		if (request.method === "POST") {
			if (request.headers.get("origin") !== appOrigin(env))
				return new Response("invalid origin", { status: 403 });
			return beginSignIn(env, installation, session.owner_id);
		}
		const profile = await env.store.member(installation, session.owner_id);
		if (profile.connection)
			return successPage(env, installation, true, session.owner_id);
		return page(
			`<div class="brand">Zuse <span>for Slack</span></div><h1>Connect your Zuse account</h1><p>Sign in securely, then return to Slack to choose a repository. No API key or model ID needed.</p><form method="post" action="/slack/setup/connect"><button>Connect Zuse account</button></form>`,
		);
	}
	if (url.pathname !== "/slack/auth/callback" || request.method !== "GET")
		return null;
	const state = url.searchParams.get("state") ?? "";
	if (!state || state !== readCookie(request, "__Host-zuse-slack-account"))
		return page(
			"<h1>Connection expired</h1><p>Start again from your private Slack connection button.</p>",
			400,
		);
	const session = await env.store.authenticate(state, "workos", true);
	const installation = session ? await env.store.get(session.team_id) : null;
	const code = url.searchParams.get("code");
	if (
		!session ||
		!installation ||
		installation.generation !== session.generation ||
		!code ||
		url.searchParams.has("error")
	)
		return page(
			"<h1>Connection cancelled or expired</h1><p>Your account was not connected. Return to Slack to try again.</p>",
			400,
		);
	const pending = JSON.parse(session.payload) as {
		verifier: string;
		revision: number;
		channel?: string;
		pendingRequest?: PendingConnectionRequest;
	};
	const profile = await env.store.member(installation, session.owner_id);
	if (profile.connection || profile.revision !== pending.revision)
		return page(
			"<h1>Connection changed</h1><p>Return to Slack and start again.</p>",
			409,
		);
	const { accountId } = await env.identity.exchange(code, pending.verifier);
	const cloud = env.cloud(accountId);
	const webhook = await registerWebhook(
		cloud,
		`${appOrigin(env)}/slack/webhook/${installation.teamId}/${installation.generation}/${session.owner_id}`,
	);
	if (
		!(await env.store.saveMember(installation, session.owner_id, {
			...profile,
			connection: {
				accountId,
				webhookId: webhook.webhook.webhookId,
				webhookSecret: webhook.secret,
			},
		}))
	) {
		await deleteWebhook(cloud, webhook.webhook.webhookId);
		return page(
			"<h1>Connection changed</h1><p>Return to Slack and retry.</p>",
			409,
		);
	}
	const response = await connectionComplete(
		env,
		installation,
		session.owner_id,
		webhook.webhook.webhookId,
		pending.channel,
		pending.pendingRequest,
	);
	response.headers.append(
		"set-cookie",
		cookie("__Host-zuse-slack-account", "", 0),
	);
	return response;
};

const connectionComplete = async (
	env: AppEnv,
	installation: Installation,
	userId: string,
	connectionId: string,
	channel?: string,
	pendingRequest?: PendingConnectionRequest,
) => {
	// Bind a saved request to the completed connection before issuing any retry link.
	if (
		pendingRequest?.job.connectionId &&
		pendingRequest.job.connectionId !== connectionId
	)
		return page(
			"<h1>Connection changed</h1><p>This request belongs to an earlier connection. Return to Slack to start a new request.</p>",
			409,
		);
	const bound = pendingRequest
		? { ...pendingRequest, job: { ...pendingRequest.job, connectionId } }
		: undefined;
	try {
		await env.JOBS.send({
			kind: "connected",
			connectionId,
			teamId: installation.teamId,
			generation: installation.generation,
			id: `connected:${connectionId}:${bound?.job.id ?? channel ?? "home"}`,
			userId,
			channel,
			pendingRequest: bound,
		});
	} catch {
		console.error("[slack-app] connection notification enqueue failed");
		const retry = await connectUrl(env, installation, userId, channel, bound);
		return page(
			`<h1>Your account is connected</h1><p>Slack could not be notified yet. Your request is saved; retry to continue without signing in again.</p><a class="action" href="${htmlEscape(retry)}">Retry Slack notification</a>`,
			503,
		);
	}
	return successPage(env, installation, true, userId);
};

export const notifyConnected = async (
	env: AppEnv,
	installation: Installation,
	job: Extract<AppJob, { kind: "connected" }>,
) => {
	const profile = await env.store.member(installation, job.userId);
	if (!job.channel || profile.connection?.webhookId !== job.connectionId)
		return;
	const state = env.store.state(installation);
	const key = `connection-notice:${job.id}`;
	if (await state.get(key)) return;
	const pending = job.pendingRequest;
	let text =
		"Zuse account connected. Mention Zuse with a task or set a repository default in Zuse’s Home tab.";
	if (pending) {
		const original = pending.job;
		const active = await executionAccount(env, installation, job.userId);
		if (
			pending.expiresAt > Date.now() &&
			original.teamId === installation.teamId &&
			original.generation === installation.generation &&
			original.userId === job.userId &&
			original.channel === job.channel &&
			original.revision === installation.revision &&
			original.connectionId === job.connectionId &&
			active?.connection.webhookId === job.connectionId
		) {
			const receipt = await state.get(
				`conversation:${original.channel}:${original.messageTs}`,
			);
			if (receipt !== "1")
				await promptRepository(env, installation, original, job.connectionId, {
					announcement:
						"Zuse account connected. Choose a repository to continue your original request.",
				});
			await state.put(key, "1", { expirationTtl: 86400 });
			return;
		}
		text =
			"Zuse account connected, but the saved request expired or account access changed. Send a new request when you’re ready.";
	}
	await slackApi(installation.credentials.botToken, "chat.postEphemeral", {
		channel: job.channel,
		user: job.userId,
		text,
	});
	await state.put(key, "1", { expirationTtl: 86400 });
};

import { renderIntegrationPage } from "@zuse/utils/integration-page";
import { disconnectMember } from "./home.ts";
