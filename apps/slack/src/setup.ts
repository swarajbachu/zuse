import { successPage } from "./accounts.ts";
import { parseAlertRules } from "./automation.ts";
import { disconnectMember } from "./home.ts";
import {
	type Installation,
	type InstallationStore,
	randomSecret,
} from "./installations.ts";
import type { AppEnv } from "./types.ts";
import { listProjects } from "./zuse.ts";

export const storeFor = (env: AppEnv): InstallationStore => env.store;

import {
	appOrigin,
	cookie,
	htmlEscape,
	page,
	readCookie,
	redirect,
} from "./web.ts";

export const oauth = async (
	request: Request,
	env: AppEnv,
): Promise<Response | null> => {
	const url = new URL(request.url);
	const store = storeFor(env);
	if (request.method !== "GET") return null;
	if (url.pathname === "/slack/install") {
		const state = await store.session("oauth");
		const target = new URL("https://slack.com/oauth/v2/authorize");
		target.search = new URLSearchParams({
			client_id: env.SLACK_CLIENT_ID,
			scope:
				"chat:write,files:read,channels:history,groups:history,app_mentions:read,im:history",
			user_scope: "channels:history,groups:history",
			redirect_uri: `${appOrigin(env)}/slack/oauth/callback`,
			state,
		}).toString();
		return redirect(
			target.toString(),
			cookie("__Host-zuse-slack-oauth", state, 600),
		);
	}
	if (url.pathname !== "/slack/oauth/callback") return null;
	const state = url.searchParams.get("state") ?? "";
	if (
		!state ||
		state !== readCookie(request, "__Host-zuse-slack-oauth") ||
		!(await store.authenticate(state, "oauth", true))
	)
		return page(
			"<h1>Installation expired</h1><p>Start again from Add to Slack.</p>",
			400,
		);
	const code = url.searchParams.get("code");
	if (!code || url.searchParams.has("error"))
		return page("<h1>Installation cancelled</h1>", 400);
	const response = await fetch("https://slack.com/api/oauth.v2.access", {
		method: "POST",
		body: new URLSearchParams({
			client_id: env.SLACK_CLIENT_ID,
			client_secret: env.SLACK_CLIENT_SECRET,
			code,
			redirect_uri: `${appOrigin(env)}/slack/oauth/callback`,
		}),
		signal: AbortSignal.timeout(10_000),
	});
	const data = (await response.json()) as {
		ok?: boolean;
		app_id?: string;
		team?: { id?: string };
		authed_user?: { id?: string; access_token?: string };
		access_token?: string;
		bot_user_id?: string;
		is_enterprise_install?: boolean;
	};
	if (
		!response.ok ||
		!data.ok ||
		data.app_id !== env.SLACK_APP_ID ||
		data.is_enterprise_install ||
		!data.team?.id ||
		!data.authed_user?.id ||
		!data.access_token ||
		!data.authed_user.access_token ||
		!data.bot_user_id
	)
		return page(
			"<h1>Installation failed</h1><p>Workspace-level access and channel history permissions are required.</p>",
			400,
		);
	let installation = await store.get(data.team.id);
	if (installation && installation.ownerId !== data.authed_user.id)
		return page(
			"<h1>Already connected</h1><p>The existing installer must manage or disconnect this installation.</p>",
			403,
		);
	if (installation) {
		if (
			!(await store.save(installation, {
				...installation.credentials,
				botToken: data.access_token,
				userToken: data.authed_user.access_token,
				botUserId: data.bot_user_id,
			}))
		)
			return page("<h1>Installation changed</h1><p>Please retry.</p>", 409);
		installation = {
			...installation,
			revision: installation.revision + 1,
			credentials: {
				...installation.credentials,
				botToken: data.access_token,
				userToken: data.authed_user.access_token,
				botUserId: data.bot_user_id,
			},
		};
	} else {
		installation = {
			teamId: data.team.id,
			ownerId: data.authed_user.id,
			generation: randomSecret(),
			revision: 0,
			credentials: {
				botToken: data.access_token,
				userToken: data.authed_user.access_token,
				botUserId: data.bot_user_id,
				accessMode: "personal",
				rules: [],
			},
		};
		if (!(await store.install(installation)))
			return page("<h1>Installation changed</h1><p>Please retry.</p>", 409);
	}
	const session = await store.session("settings", installation);
	const installed = await successPage(env, installation, false);
	installed.headers.set(
		"set-cookie",
		cookie("__Host-zuse-slack-setup", session, 3600),
	);
	return installed;
};

const formValue = (form: URLSearchParams, name: string): string =>
	(form.get(name) ?? "").trim();
const setupPage = async (
	env: AppEnv,
	installation: Installation,
): Promise<Response> => {
	const connected = (await env.store.member(installation, installation.ownerId))
		.connection;
	let content = `<h1>Zuse for Slack</h1><p>Workspace ${htmlEscape(installation.teamId)} · Only this workspace’s installer can manage these settings.</p>`;
	if (!connected)
		return page(
			`<h1>Connect from Slack</h1><p>Open Zuse’s Home tab to connect your account before creating automations.</p>`,
		);
	const { projects } = await listProjects(env.cloud(connected.accountId));
	content += `<p>Manage your account and repository defaults in Zuse’s Home tab in Slack.</p>`;
	content +=
		"<h2>Your automations</h2><p>Trigger: Better Stack production error or error spike. Action: investigate in Zuse and post results in the same Slack thread.</p>";
	for (const rule of installation.credentials.rules)
		content += `<section><strong>${htmlEscape(rule.id)}</strong><p>${htmlEscape(rule.channelId)} → ${htmlEscape(rule.projectId)} · ${rule.mode}</p><form method="post" action="/slack/setup/remove-rule"><input type="hidden" name="id" value="${htmlEscape(rule.id)}"><input type="hidden" name="revision" value="${installation.revision}"><button>Remove automation</button></form></section>`;
	content += `<h2>Create automation</h2><p>Invite Zuse to the chosen channel. Use the source alert’s bot ID (B…), not its display name. Start in dry-run mode.</p><form method="post" action="/slack/setup/rule"><input type="hidden" name="revision" value="${installation.revision}"><label>Name / ID<input name="id" required pattern="[A-Za-z0-9_-]{1,64}" maxlength="64"></label><label>Slack channel ID<input name="channelId" required placeholder="C…"></label><label>Alert source bot ID<input name="botId" required placeholder="B…"></label><label>Zuse project<select name="projectId" required>${projects
		.filter((project) => project.state === "ready")
		.map(
			(project) =>
				`<option value="${htmlEscape(project.projectId)}">${htmlEscape(project.displayName)}</option>`,
		)
		.join(
			"",
		)}</select></label><label>Mode<select name="mode"><option value="dry-run">Dry run — no agent execution</option><option value="live">Live — start agent investigations</option></select></label><button>Save automation</button></form><p class="muted">Saving an existing ID replaces that automation. Agents use your Zuse account’s access. Do not provide production deployment credentials.</p><h2>Disconnect</h2><form method="post" action="/slack/setup/disconnect"><input type="hidden" name="revision" value="${installation.revision}"><button>Disconnect Zuse and remove automations</button></form><p>Reopen Zuse’s App Home in Slack to refresh its summary.</p>`;
	return page(content);
};

export const settings = async (
	request: Request,
	env: AppEnv,
): Promise<Response | null> => {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/slack/setup")) return null;
	const store = storeFor(env);
	if (url.pathname === "/slack/setup/login" && request.method === "GET") {
		const login = await store.authenticate(
			url.searchParams.get("token") ?? "",
			"login",
			true,
		);
		const installation = login ? await store.get(login.team_id) : null;
		if (
			!installation ||
			installation.ownerId !== login?.owner_id ||
			installation.generation !== login.generation
		)
			return page(
				"<h1>Link expired</h1><p>Reopen App Home for a new private setup link.</p>",
				401,
			);
		return redirect(
			"/slack/setup/automations",
			cookie(
				"__Host-zuse-slack-setup",
				await store.session("settings", installation),
				3600,
			),
		);
	}
	const session = await store.authenticate(
		readCookie(request, "__Host-zuse-slack-setup"),
		"settings",
	);
	const installation = session ? await store.get(session.team_id) : null;
	if (
		!installation ||
		installation.ownerId !== session?.owner_id ||
		installation.generation !== session.generation
	)
		return page(
			"<h1>Sign in from Slack</h1><p>Open Zuse’s App Home to manage your connection.</p>",
			401,
		);
	if (request.method === "GET" && url.pathname === "/slack/setup/automations")
		return setupPage(env, installation);
	if (request.method !== "POST")
		return new Response("not found", { status: 404 });
	if (request.headers.get("origin") !== appOrigin(env))
		return new Response("invalid origin", { status: 403 });
	const form = new URLSearchParams(await request.text());
	const profile = await env.store.member(installation, installation.ownerId);
	const zuse = profile.connection;
	if (formValue(form, "revision") !== String(installation.revision))
		return page("<p>Settings changed. Reload before saving.</p>", 409);
	if (!zuse) return page("<p>Connect Zuse first.</p>", 400);
	let credentials = installation.credentials;
	if (url.pathname === "/slack/setup/project") {
		const projectId = formValue(form, "projectId");
		const { projects } = await listProjects(env.cloud(zuse.accountId));
		if (
			!projects.some(
				(project) =>
					project.projectId === projectId && project.state === "ready",
			)
		)
			return page(
				"<p>Select a ready repository from your connected account.</p>",
				400,
			);
		if (
			!(await env.store.saveMember(installation, installation.ownerId, {
				...profile,
				defaults: { ...profile.defaults, projectId },
			}))
		)
			return page("<p>Settings changed. Reload and try again.</p>", 409);
		return redirect("/slack/setup/automations");
	} else if (url.pathname === "/slack/setup/rule") {
		let rules: ReturnType<typeof parseAlertRules>;
		try {
			rules = parseAlertRules(
				JSON.stringify([
					...credentials.rules.filter(
						(rule) => rule.id !== formValue(form, "id"),
					),
					Object.fromEntries(
						["id", "channelId", "botId", "projectId", "mode"].map((key) => [
							key,
							formValue(form, key),
						]),
					),
				]),
			);
		} catch {
			return page(
				"<p>Invalid automation. Check its name, channel, bot, project and mode.</p>",
				400,
			);
		}
		const { projects } = await listProjects(env.cloud(zuse.accountId));
		if (
			!projects.some(
				(project) =>
					project.projectId === formValue(form, "projectId") &&
					project.state === "ready",
			)
		)
			return page(
				"<p>Select a ready project belonging to your connected Zuse account.</p>",
				400,
			);
		credentials = { ...credentials, rules };
	} else if (url.pathname === "/slack/setup/remove-rule")
		credentials = {
			...credentials,
			rules: credentials.rules.filter(
				(rule) => rule.id !== formValue(form, "id"),
			),
		};
	else if (url.pathname === "/slack/setup/disconnect")
		credentials = {
			botToken: credentials.botToken,
			userToken: credentials.userToken,
			botUserId: credentials.botUserId,
			accessMode: credentials.accessMode,
			rules: [],
		};
	else return new Response("not found", { status: 404 });
	if (!(await store.save(installation, credentials)))
		return page("<p>Settings changed. Reload and try again.</p>", 409);
	if (url.pathname === "/slack/setup/disconnect")
		await disconnectMember(
			env,
			installation,
			installation.ownerId,
			zuse.webhookId,
		);
	return redirect("/slack/setup/automations");
};
