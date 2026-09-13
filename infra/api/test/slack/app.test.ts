import { executionAccount } from "@zuse/slack/access";
import { connectUrl } from "@zuse/slack/accounts";
import { agentOptions, resolveAgentChoice } from "@zuse/slack/agent-choice";
import { matchAlert, parseAlertRules } from "@zuse/slack/automation";
import { disconnectMember, publishHome } from "@zuse/slack/home";
import {
	type Installation,
	InstallationStore,
} from "@zuse/slack/installations";
import {
	readProgress,
	refreshStatus,
	startProgress,
	updateProgress,
} from "@zuse/slack/progress";
import { handleZuseWebhook, runnerEnv } from "@zuse/slack/runner";
import { downloadSlackFile, readSlackThread } from "@zuse/slack/slack";
import type { AppEnv, AppJob } from "@zuse/slack/types";
import worker from "@zuse/slack/worker";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCipher, testDatabase } from "./test-support.ts";

const databases: ReturnType<typeof testDatabase>[] = [];
const setup = async (teamId = "T1", connected = true) => {
	const db = testDatabase();
	databases.push(db);
	const jobs: AppJob[] = [];
	const env: AppEnv = {
		store: new InstallationStore(db.binding, testCipher),
		identity: {
			clientId: "client_workos",
			exchange: vi.fn(async () => ({ accountId: "user_new" })),
		},
		cloud: () => ({
			request: (path, init) =>
				globalThis.fetch(`https://api.test${path}`, init),
		}),
		JOBS: {
			send: async (job) => {
				jobs.push(job);
			},
		},
		APP_ORIGIN: "https://app.test",
		SLACK_APP_ID: "A1",
		SLACK_CLIENT_ID: "client",
		SLACK_CLIENT_SECRET: "client-secret",
		SLACK_SIGNING_SECRET: "signing",
	};
	const store = env.store;
	const installation: Installation = {
		teamId,
		ownerId: "U1",
		generation: "b".repeat(64),
		revision: 0,
		credentials: {
			botToken: "xoxb-test",
			userToken: "xoxp-test",
			botUserId: "UBOT",
			...(connected
				? {
						zuse: {
							accountId: "user_customer",
							webhookId: "wh_1",
							webhookSecret: "whsec_1",
							agent: "codex",
							model: "gpt-test",
							projectId: "p1",
						},
					}
				: {}),
			rules: [
				{
					id: "errors",
					channelId: "C1",
					botId: "B1",
					projectId: "project_equity",
					mode: "dry-run",
				},
			],
		},
	};
	await store.install(installation);
	const pending: Promise<unknown>[] = [];
	const context = {
		waitUntil: (promise: Promise<unknown>) => {
			pending.push(promise);
		},
	};
	const fetch = (request: Request) => worker.fetch(request, env, context);
	const event = async (
		value: object,
		overrides: object = {},
		secret = env.SLACK_SIGNING_SECRET,
	) =>
		fetch(
			await signed(
				JSON.stringify({
					type: "event_callback",
					team_id: teamId,
					api_app_id: "A1",
					event_id: "Ev1",
					event: value,
					...overrides,
				}),
				secret,
			),
		);
	const consume = async (attempts = 1) => {
		const ack = vi.fn();
		const retry = vi.fn();
		await worker.queue(
			{ messages: jobs.map((body) => ({ body, attempts, ack, retry })) },
			env,
		);
		return { ack, retry };
	};
	const session = await store.session("settings", installation);
	const requestSettings = (
		path: string,
		form?: Record<string, string>,
		origin = env.APP_ORIGIN,
	) =>
		fetch(
			new Request(`${env.APP_ORIGIN}${path}`, {
				method: form ? "POST" : "GET",
				headers: { cookie: `__Host-zuse-slack-setup=${session}`, origin },
				...(form ? { body: new URLSearchParams(form) } : {}),
			}),
		);
	return {
		env,
		installation,
		store,
		fetch,
		event,
		consume,
		jobs,
		db,
		requestSettings,
		pending,
	};
};

const signed = async (
	body: string,
	secret = "signing",
	timestamp = String(Math.floor(Date.now() / 1000)),
) => {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`v0:${timestamp}:${body}`),
		),
	);
	return new Request("https://app.test/slack/events", {
		method: "POST",
		headers: {
			"x-slack-request-timestamp": timestamp,
			"x-slack-signature": `v0=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
		},
		body,
	});
};
const alert = {
	type: "message",
	channel: "C1",
	ts: "123.456",
	bot_id: "B1",
	text: "Spike detected in Error in production from Equity",
};

const interactWith = async (
	app: Awaited<ReturnType<typeof setup>>,
	payload: Record<string, unknown>,
	user = "U1",
) => {
	const request = await signed(
		new URLSearchParams({
			payload: JSON.stringify({
				api_app_id: "A1",
				team: { id: "T1" },
				user: { id: user },
				...payload,
			}),
		}).toString(),
	);
	return app.fetch(
		new Request("https://app.test/slack/interactions", {
			method: "POST",
			headers: request.headers,
			body: await request.text(),
		}),
	);
};

describe("conversational Slack app", () => {
	const mention = {
		type: "app_mention",
		channel: "C1",
		ts: "200.001",
		user: "U1",
		text: "<@UBOT> fix the failing test",
	};
	const mockServices = () => {
		const calls: {
			url: string;
			body: Record<string, unknown>;
			init?: RequestInit;
		}[] = [];
		const result = {
			threadMessages: [
				{
					ts: "200.001",
					user: "U1",
					text: "fix the failing test",
					files: [] as import("@zuse/slack/slack").SlackFileMetadata[],
				},
			],
			finished: false,
			threadError: "",
			updateError: "",
			projectStatus: 200,
			missingAgent: false,
			requestStatus: "delivered",
			nativeSupported: true,
			nativeStatus: "",
			clearStatusFailures: 0,
			workspaceError: "",
			state: "ready",
			projects: [
				{ projectId: "p1", displayName: "Repository one", state: "ready" },
			],
		};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				const body =
					typeof init?.body === "string" ? JSON.parse(init.body) : {};
				calls.push({ url, body, init });
				if (url.endsWith("/v1/api/webhooks"))
					return Response.json({
						webhook: { webhookId: "wh_new" },
						secret: "whsec_new",
					});
				if (url.endsWith("/v1/api/projects"))
					return Response.json(
						{ projects: result.projects },
						{ status: result.projectStatus },
					);
				if (url.includes("conversations.replies"))
					if (result.threadError)
						return Response.json({ ok: false, error: result.threadError });
				if (url.includes("conversations.replies"))
					return Response.json({
						ok: true,
						messages: result.threadMessages,
					});
				if (
					url.endsWith("/v1/api/workspaces") &&
					result.missingAgent &&
					(!body.agent || !body.model)
				)
					return Response.json(
						{ error: "agent_and_model_required" },
						{ status: 400 },
					);
				if (url.endsWith("/v1/api/workspaces") && result.workspaceError)
					return Response.json(
						{ error: result.workspaceError },
						{ status: 400 },
					);
				if (url.endsWith("/v1/api/workspaces"))
					return Response.json({
						workspace: { workspaceId: "w1", branch: "slack-fix" },
					});
				if (url.endsWith("/workspaces/w1"))
					return Response.json({
						workspace: {
							workspaceId: "w1",
							state: result.state,
							agentStatus: result.finished ? "idle" : "working",
						},
					});
				if (url.endsWith("/messages"))
					return Response.json({ messageId: "m1", seq: 1, status: "queued" });
				if (url.includes("/messages?"))
					return Response.json({
						messages: [
							{
								messageId: "m1",
								role: "user",
								turnId: "turn1",
								status: result.requestStatus,
							},
							...(result.finished
								? [
										{
											messageId: "a1",
											role: "assistant",
											turnId: "turn1",
											text: "Fixed parser.ts. Regression test passed.",
											outcome: "completed",
										},
									]
								: []),
						],
					});
				if (url.includes("threads.setStatus")) {
					if (body.status === "" && result.clearStatusFailures > 0) {
						result.clearStatusFailures--;
						return Response.json(
							{ ok: false, error: "ratelimited" },
							{ status: 429, headers: { "retry-after": "2" } },
						);
					}
					if (result.nativeSupported) result.nativeStatus = String(body.status);
					return Response.json(
						result.nativeSupported
							? { ok: true }
							: { ok: false, error: "feature_disabled" },
					);
				}
				if (url.endsWith("chat.postMessage"))
					return Response.json({ ok: true, ts: "201.001" });
				if (url.endsWith("chat.postEphemeral"))
					return Response.json({ ok: true });
				if (url.endsWith("views.open"))
					return Response.json({ ok: true, view: { id: "V1" } });
				if (url.endsWith("views.update")) return Response.json({ ok: true });
				if (url.endsWith("chat.update") && result.updateError)
					return Response.json({ ok: false, error: result.updateError });
				if (
					url.endsWith("chat.update") ||
					url.endsWith("chat.delete") ||
					url.endsWith("views.publish")
				)
					return Response.json({ ok: true });
				if (url.startsWith("https://files.slack.com/"))
					return new Response(new Uint8Array([1, 2, 3, 4]));
				if (url.endsWith("/attachments"))
					return Response.json({ asset: { assetId: "asset_1" } });
				throw new Error(`Unexpected request ${url}`);
			}),
		);
		return {
			calls,
			result,
			posts: () =>
				calls.filter((call) => call.url.endsWith("chat.postMessage")),
			updates: () => calls.filter((call) => call.url.endsWith("chat.update")),
			replies: () =>
				calls.filter(
					(call) =>
						call.url.endsWith("chat.update") ||
						call.url.endsWith("chat.postMessage"),
				),
			ephemerals: () =>
				calls.filter((call) => call.url.endsWith("chat.postEphemeral")),
		};
	};
	it("uses only native status while preparing a request", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		expect(http.result.nativeStatus).not.toBe("");
		expect(http.posts()).toHaveLength(0);
		expect(http.replies()).toHaveLength(0);
		http.result.finished = true;
		await consumeNext(app);
		expect(http.posts()).toHaveLength(1);
		expect(http.posts()[0]?.body.text).toContain("Fixed parser.ts");
		expect(http.result.nativeStatus).toBe("");
	});
	it("removes an old loading card when native status becomes available", async () => {
		const app = await setup();
		const http = mockServices();
		const scoped = runnerEnv(app.env, app.installation);
		http.result.nativeSupported = false;
		await startProgress(scoped, {
			key: "resume",
			channel: "C1",
			threadTs: "200.001",
		});
		expect(http.posts()).toHaveLength(1);
		http.result.nativeSupported = true;
		await updateProgress(
			scoped,
			"resume",
			"Preparing your repository and workspace",
		);
		expect(
			http.calls.filter((c) => c.url.endsWith("chat.delete")),
		).toHaveLength(1);
		expect((await readProgress(scoped, "resume"))?.statusTs).toBeUndefined();
		expect(http.result.nativeStatus).toBe(
			"Preparing your repository and workspace",
		);
	});
	const consumeNext = async (
		app: Awaited<ReturnType<typeof setup>>,
		attempts = 1,
	) => {
		const body = app.jobs.shift();
		if (!body) throw new Error("Expected queued job");
		const ack = vi.fn();
		const retry = vi.fn();
		await worker.queue({ messages: [{ body, attempts, ack, retry }] }, app.env);
		return { ack, retry, body };
	};
	it.each([
		"app_mention",
		"message",
	])("answers greetings via %s without allocating a workspace", async (type) => {
		const app = await setup();
		const http = mockServices();
		expect(
			(
				await app.event({
					...mention,
					type,
					channel: type === "message" ? "D1" : "C1",
					text: "<@UBOT> help",
				})
			).status,
		).toBe(200);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.posts()[0]?.body.text).toContain("Hi!");
		expect(http.calls.some((call) => call.url.includes("workspaces"))).toBe(
			false,
		);
	});
	it("explains missing account setup and refuses another user's credentials", async () => {
		const app = await setup("T1", false);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		expect(http.ephemerals()[0]?.body).toMatchObject({
			user: "U1",
			channel: "C1",
		});
		expect(http.ephemerals()[0]?.body.text).toContain(
			"Connect your Zuse account",
		);
		await app.event({ ...mention, ts: "200.002", user: "UOTHER" });
		await consumeNext(app);
		expect(http.ephemerals()[1]?.body.text).toContain("installer-only");
		expect(
			http.calls.every((call) => call.url.endsWith("chat.postEphemeral")),
		).toBe(true);
	});
	it("requires a repository choice when multiple projects are ready", async () => {
		const app = await setup();
		await clearDefault(app);
		const http = mockServices();
		http.result.projects.push({
			projectId: "p2",
			displayName: "Two",
			state: "ready",
		});
		await app.event(mention);
		await consumeNext(app);
		expect(http.ephemerals()[0]?.body.text).toContain("Choose a repository");
		expect(http.calls.some((call) => call.url.endsWith("/workspaces"))).toBe(
			false,
		);
	});
	const clearDefault = async (app: Awaited<ReturnType<typeof setup>>) => {
		const profile = await app.store.member(app.installation, "U1");
		if (!profile.connection) throw new Error("Expected connection");
		await app.store.saveMember(app.installation, "U1", {
			...profile,
			connection: { ...profile.connection, projectId: undefined },
			defaults: { channels: {} },
		});
	};
	const pickerToken = (http: ReturnType<typeof mockServices>) => {
		const token = JSON.stringify(http.ephemerals().at(-1)?.body).match(
			/"value":"([a-f0-9]{64})"/u,
		)?.[1];
		if (!token) throw new Error("Expected private picker token");
		return token;
	};
	const connectionLink = (http: ReturnType<typeof mockServices>) => {
		const link = JSON.stringify(http.ephemerals().at(-1)?.body).match(
			/"url":"([^"]+)"/u,
		)?.[1];
		if (!link) throw new Error("Expected private connection link");
		return link;
	};
	const completeSignIn = async (
		app: Awaited<ReturnType<typeof setup>>,
		link: string,
	) => {
		const begin = await app.fetch(new Request(link));
		expect(begin.status).toBe(303);
		const target = new URL(begin.headers.get("location") ?? "");
		return app.fetch(
			new Request(
				`https://app.test/slack/auth/callback?code=verified&state=${target.searchParams.get("state")}`,
				{
					headers: {
						cookie: begin.headers.get("set-cookie")?.split(";")[0] ?? "",
					},
				},
			),
		);
	};
	it("requests fresh authentication after disconnecting from Slack Home", async () => {
		const app = await setup();
		mockServices();
		await disconnectMember(app.env, app.installation, "U1", "wh_1");
		const link = await connectUrl(app.env, app.installation, "U1");
		const response = await app.fetch(new Request(link));
		expect(response.status).toBe(303);
		const target = new URL(response.headers.get("location") ?? "");
		expect(target.searchParams.get("prompt")).toBe("login");
		expect(target.searchParams.get("max_age")).toBe("0");
		expect(target.searchParams.get("screen_hint")).toBe("sign-in");
		expect(target.searchParams.get("code_challenge_method")).toBe("S256");
	});
	it("lets the connected browser log out and authenticate a different account", async () => {
		const app = await setup("T1", false);
		const http = mockServices();
		const connected = await completeSignIn(
			app,
			await connectUrl(app.env, app.installation, "U1"),
		);
		const html = await connected.text();
		expect(html).toContain("Slack integration stamp");
		expect(html).toContain("Log out of Slack connection");
		expect(connected.headers.get("referrer-policy")).toBe("same-origin");
		const browserCookie = connected.headers
			.getSetCookie()
			.find((c) => c.startsWith("__Host-zuse-slack-member="))
			?.split(";")[0];
		const csrf = html.match(/name="csrf" value="([a-f0-9]+)"/u)?.[1];
		if (!browserCookie || !csrf)
			throw new Error("Expected protected account controls");
		const logout = (origin = "https://app.test", nonce = csrf) =>
			app.fetch(
				new Request("https://app.test/slack/account/logout", {
					method: "POST",
					headers: { cookie: browserCookie, origin },
					body: new URLSearchParams({ csrf: nonce }),
				}),
			);
		expect(
			(await app.fetch(new Request("https://app.test/slack/account/logout")))
				.status,
		).toBe(405);
		expect((await logout("https://foreign.test")).status).toBe(403);
		expect((await logout("null")).status).toBe(403);
		expect((await logout("https://app.test", "wrong")).status).toBe(403);
		expect(
			(await app.store.member(app.installation, "U1")).connection,
		).not.toBeNull();
		const loggedOut = await logout();
		expect(loggedOut.status).toBe(200);
		expect(
			(await app.store.member(app.installation, "U1")).connection,
		).toBeNull();
		expect((await logout()).status).toBe(401);
		const reconnect = (await loggedOut.text()).match(
			/href="([^"]+\/slack\/account\/connect\?token=[a-f0-9]+)"/u,
		)?.[1];
		if (!reconnect) throw new Error("Expected fresh sign-in link");
		const begin = await app.fetch(new Request(reconnect));
		const target = new URL(begin.headers.get("location") ?? "");
		expect(target.searchParams.get("prompt")).toBe("login");
		expect(target.searchParams.get("max_age")).toBe("0");
		vi.mocked(app.env.identity.exchange).mockResolvedValueOnce({
			accountId: "user_other",
		});
		const response = await app.fetch(
			new Request(
				`https://app.test/slack/auth/callback?code=verified&state=${target.searchParams.get("state")}`,
				{
					headers: {
						cookie: begin.headers.get("set-cookie")?.split(";")[0] ?? "",
					},
				},
			),
		);
		expect(response.status).toBe(200);
		expect(
			(await app.store.member(app.installation, "U1")).connection?.accountId,
		).toBe("user_other");
		expect(http.calls.some((c) => c.init?.method === "DELETE")).toBe(true);
	});
	it("does not allow an old browser page to disconnect a replacement account", async () => {
		const app = await setup();
		mockServices();
		const response = await app.fetch(
			new Request(await connectUrl(app.env, app.installation, "U1")),
		);
		const csrf = (await response.text()).match(
			/name="csrf" value="([a-f0-9]+)"/u,
		)?.[1];
		const browserCookie = response.headers
			.getSetCookie()
			.find((c) => c.startsWith("__Host-zuse-slack-member="))
			?.split(";")[0];
		if (!csrf || !browserCookie) throw new Error("Expected account controls");
		const profile = await app.store.member(app.installation, "U1");
		if (!profile.connection) throw new Error("Expected connection");
		await app.store.saveMember(app.installation, "U1", {
			...profile,
			connection: { ...profile.connection, webhookId: "replacement" },
		});
		const rejected = await app.fetch(
			new Request("https://app.test/slack/account/logout", {
				method: "POST",
				headers: { cookie: browserCookie, origin: "https://app.test" },
				body: new URLSearchParams({ csrf }),
			}),
		);
		expect(rejected.status).toBe(409);
		expect(
			(await app.store.member(app.installation, "U1")).connection?.webhookId,
		).toBe("replacement");
	});
	const repositorySubmission = (token: string) => ({
		type: "view_submission",
		view: {
			id: "V1",
			callback_id: "select_repository",
			private_metadata: token,
			state: {
				values: {
					repository: { project: { selected_option: { value: "p1" } } },
				},
			},
		},
	});
	it("continues the original request and image after sign-in without resending or duplicate work", async () => {
		const app = await setup("T1", false);
		const http = mockServices();
		const files = [
			{
				id: "F1",
				name: "failure.png",
				mimetype: "image/png",
				size: 4,
				url_private_download: "https://files.slack.com/failure.png",
			},
		];
		await app.event({ ...mention, files });
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		const link = connectionLink(http);
		// Slack redelivery cannot consume or replace the saved request.
		await app.event({ ...mention, files });
		await consumeNext(app);
		expect(http.ephemerals()).toHaveLength(1);
		expect((await completeSignIn(app, link)).status).toBe(200);
		const connected = app.jobs[0];
		expect(connected).toMatchObject({
			kind: "connected",
			pendingRequest: { job: { text: mention.text, files } },
		});
		if (!connected) throw new Error("Expected connected job");
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.ephemerals().at(-1)?.body).toMatchObject({
			user: "U1",
			channel: "C1",
			text: "Zuse account connected. Choose a repository to continue your original request.",
		});
		expect(
			http.calls.filter((c) => c.url.endsWith("/workspaces")),
		).toHaveLength(0);
		const token = pickerToken(http);
		const action = {
			type: "block_actions",
			trigger_id: "trigger",
			actions: [{ action_id: "open_repository", value: token }],
		};
		expect((await interactWith(app, action, "UOTHER")).status).toBe(403);
		expect((await interactWith(app, action)).status).toBe(200);
		await consumeNext(app);
		expect(
			await (await interactWith(app, repositorySubmission(token))).json(),
		).toEqual({ response_action: "clear" });
		const selection = app.jobs[0];
		if (!selection) throw new Error("Expected repository selection");
		app.jobs.push(connected, selection);
		await consumeNext(app);
		await consumeNext(app);
		await consumeNext(app);
		expect(http.ephemerals()).toHaveLength(2);
		expect(
			http.calls.filter((c) => c.url.endsWith("/workspaces")),
		).toHaveLength(1);
		const messages = http.calls.filter((c) => c.url.endsWith("/messages"));
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages[0]?.body)).toContain("fix the failing test");
		expect(JSON.stringify(messages[0]?.body)).toContain("asset_1");
		const upload = http.calls.find((c) => c.url.endsWith("/attachments"));
		const bytes = upload?.init?.body;
		expect(bytes).toBeInstanceOf(ArrayBuffer);
		if (!(bytes instanceof ArrayBuffer))
			throw new Error("Expected uploaded image");
		expect(new Uint8Array(bytes)).toEqual(new Uint8Array([1, 2, 3, 4]));
	});
	it("continues a saved request when another tab already connected the account", async () => {
		const app = await setup("T1", false);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const original = connectionLink(http);
		const other = await connectUrl(app.env, app.installation, "U1");
		expect((await completeSignIn(app, other)).status).toBe(200);
		await consumeNext(app);
		expect((await app.fetch(new Request(original))).status).toBe(200);
		await consumeNext(app);
		expect(pickerToken(http)).toMatch(/^[a-f0-9]{64}$/u);
		expect(app.env.identity.exchange).toHaveBeenCalledTimes(1);
	});
	it.each([
		"expiry",
		"policy",
		"user",
		"channel",
		"account",
	])("does not resume after a saved request's %s changes", async (change) => {
		const app = await setup("T1", false);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		await completeSignIn(app, connectionLink(http));
		const connected = app.jobs.shift();
		if (connected?.kind !== "connected" || !connected.pendingRequest)
			throw new Error("Expected pending request");
		const pending = connected.pendingRequest;
		if (change === "account") {
			const profile = await app.store.member(app.installation, "U1");
			if (!profile.connection) throw new Error("Expected connection");
			await app.store.saveMember(app.installation, "U1", {
				...profile,
				connection: { ...profile.connection, webhookId: "wh_replacement" },
			});
		}
		app.jobs.push({
			...connected,
			pendingRequest: {
				...pending,
				expiresAt: change === "expiry" ? Date.now() - 1 : pending.expiresAt,
				job: {
					...pending.job,
					...(change === "policy" ? { revision: -1 } : {}),
					...(change === "user" ? { userId: "UOTHER" } : {}),
					...(change === "channel" ? { channel: "COTHER" } : {}),
				},
			},
		});
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(JSON.stringify(http.ephemerals())).not.toContain("open_repository");
		expect(http.calls.some((c) => c.url.includes("/workspaces"))).toBe(false);
		if (change !== "account")
			expect(http.ephemerals().at(-1)?.body.text).toContain(
				"expired or account access changed",
			);
	});
	it("offers a bound retry when the connection notification cannot be queued", async () => {
		const app = await setup("T1", false);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const send = vi
			.spyOn(app.env.JOBS, "send")
			.mockRejectedValueOnce(new Error("queue unavailable"));
		const response = await completeSignIn(app, connectionLink(http));
		expect(response.status).toBe(503);
		const retry = (await response.text()).match(
			/href="([^"]+)">Retry Slack notification/u,
		)?.[1];
		if (!retry) throw new Error("Expected recoverable notification link");
		expect(app.jobs).toHaveLength(0);
		send.mockRestore();
		expect((await app.fetch(new Request(retry))).status).toBe(200);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(pickerToken(http)).toMatch(/^[a-f0-9]{64}$/u);
		expect(app.env.identity.exchange).toHaveBeenCalledTimes(1);
		expect(http.calls.filter((c) => c.url.endsWith("/webhooks"))).toHaveLength(
			1,
		);
	});
	it("cannot use a notification retry to move a request to a replacement account", async () => {
		const app = await setup("T1", false);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const send = vi
			.spyOn(app.env.JOBS, "send")
			.mockRejectedValueOnce(new Error("queue unavailable"));
		const response = await completeSignIn(app, connectionLink(http));
		const retry = (await response.text()).match(
			/href="([^"]+)">Retry Slack notification/u,
		)?.[1];
		if (!retry) throw new Error("Expected retry link");
		send.mockRestore();
		const profile = await app.store.member(app.installation, "U1");
		if (!profile.connection) throw new Error("Expected connection");
		await app.store.saveMember(app.installation, "U1", {
			...profile,
			connection: {
				...profile.connection,
				accountId: "replacement",
				webhookId: "wh_replacement",
			},
		});
		expect((await app.fetch(new Request(retry))).status).toBe(409);
		expect(app.jobs).toHaveLength(0);
	});
	it("opens a loading modal, restricts it to its user, resumes the task and remembers defaults exactly once", async () => {
		const app = await setup();
		await clearDefault(app);
		const http = mockServices();
		await app.event(mention);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		const token = pickerToken(http);
		expect(http.ephemerals()[0]?.body).toMatchObject({
			user: "U1",
			channel: "C1",
		});
		expect(http.ephemerals()[0]?.body).not.toHaveProperty("thread_ts");
		const action = {
			type: "block_actions",
			trigger_id: "trigger",
			actions: [
				{ action_id: "open_repository", value: token, action_ts: "201" },
			],
		};
		expect((await interactWith(app, action, "UOTHER")).status).toBe(403);
		const before = http.calls.length;
		expect((await interactWith(app, action)).status).toBe(200);
		expect(http.calls.slice(before).map((c) => c.url)).toEqual([
			"https://slack.com/api/views.open",
		]);
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"Loading repository and agent options",
		);
		await consumeNext(app);
		expect(http.calls.at(-1)?.url).toContain("views.update");
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"Set as default for this channel",
		);
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"Agent and model",
		);
		const submission = {
			type: "view_submission",
			view: {
				id: "V1",
				callback_id: "select_repository",
				private_metadata: token,
				state: {
					values: {
						repository: { project: { selected_option: { value: "p1" } } },
						defaults: {
							remember: {
								selected_options: [{ value: "channel" }, { value: "personal" }],
							},
						},
						agent: {
							choice: { selected_option: { value: agentOptions()[0]?.value } },
						},
					},
				},
			},
		};
		expect(
			await (await interactWith(app, submission, "UOTHER")).json(),
		).toMatchObject({ response_action: "errors" });
		expect(await (await interactWith(app, submission)).json()).toEqual({
			response_action: "clear",
		});
		const selection = app.jobs[0];
		if (!selection) throw new Error("Expected selection");
		app.jobs.push(selection);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			http.calls.filter((c) => c.url.endsWith("/v1/api/workspaces")),
		).toHaveLength(1);
		expect(http.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(
			1,
		);
		expect((await app.store.member(app.installation, "U1")).defaults).toEqual({
			projectId: "p1",
			channels: { C1: "p1" },
		});
		const expectedAgent = resolveAgentChoice(agentOptions()[0]?.value);
		if (!expectedAgent) throw new Error("Expected catalog choice");
		expect(
			http.calls.find((c) => c.url.endsWith("/v1/api/workspaces"))?.body,
		).toMatchObject(expectedAgent);
		expect(
			http.calls.find((c) => c.url.includes("threads.setStatus"))?.body.status,
		).toBe("Zusing…");
	});
	it("refuses a forged repository outside the connected account", async () => {
		const app = await setup();
		await clearDefault(app);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		await interactWith(app, {
			type: "view_submission",
			view: {
				id: "V1",
				callback_id: "select_repository",
				private_metadata: pickerToken(http),
				state: {
					values: {
						repository: { project: { selected_option: { value: "foreign" } } },
					},
				},
			},
		});
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.ephemerals().at(-1)?.body.text).toContain(
			"no longer available",
		);
		expect(http.calls.some((c) => c.url.endsWith("/workspaces"))).toBe(false);
	});
	it("expires picker authority when workspace access mode changes", async () => {
		const app = await setup();
		await clearDefault(app);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const token = pickerToken(http);
		await app.store.save(app.installation, {
			...app.installation.credentials,
			accessMode: "personal",
		});
		expect(
			(
				await interactWith(app, {
					type: "block_actions",
					trigger_id: "trigger",
					actions: [{ action_id: "open_repository", value: token }],
				})
			).status,
		).toBe(403);
	});
	it("uses each member's own cloud account and never the installer's Slack user token", async () => {
		const app = await setup();
		const http = mockServices();
		await app.store.save(app.installation, {
			...app.installation.credentials,
			accessMode: "personal",
		});
		await app.store.saveMember(app.installation, "UOTHER", {
			revision: -1,
			connection: {
				accountId: "other_account",
				webhookId: "wh_other",
				webhookSecret: "secret_other",
			},
			defaults: { projectId: "p1", channels: {} },
		});
		const cloud = vi.spyOn(app.env, "cloud");
		await app.event({ ...mention, user: "UOTHER", thread_ts: "100.001" });
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			cloud.mock.calls.every(([account]) => account === "other_account"),
		).toBe(true);
		expect(
			http.calls.find((c) => c.url.includes("conversations.replies"))?.init
				?.headers,
		).toMatchObject({ authorization: "Bearer xoxb-test" });
		expect(
			http.calls.find((c) => c.url.endsWith("/workspaces"))?.body,
		).not.toHaveProperty("agent");
		expect(app.jobs[0]).toMatchObject({
			kind: "progress",
			userId: "UOTHER",
			connectionId: "wh_other",
		});
		http.result.finished = true;
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.replies().at(-1)?.body.text).toContain("Fixed parser.ts");
	});
	it("allows only the installer to opt into team sharing and blocks shared members from changing its defaults", async () => {
		const app = await setup();
		mockServices();
		const action = {
			type: "block_actions",
			view: { private_metadata: "0" },
			actions: [
				{ action_id: "access_mode", selected_option: { value: "shared" } },
			],
		};
		expect((await interactWith(app, action, "UOTHER")).status).toBe(403);
		expect((await interactWith(app, action)).status).toBe(200);
		await consumeNext(app);
		const current = await app.store.get("T1");
		if (!current) throw new Error("Missing installation");
		expect(
			(await executionAccount(app.env, current, "UOTHER"))?.connection
				.accountId,
		).toBe("user_customer");
		await interactWith(
			app,
			{
				type: "block_actions",
				view: {
					private_metadata: JSON.stringify({ revision: 1, memberRevision: -1 }),
				},
				actions: [
					{
						action_id: "select_project",
						selected_option: { value: "foreign" },
					},
				],
			},
			"UOTHER",
		);
		await consumeNext(app);
		expect((await app.store.member(current, "U1")).defaults.projectId).toBe(
			"p1",
		);
	});
	it("shows a useful error instead of leaving the repository modal loading forever", async () => {
		const app = await setup();
		await clearDefault(app);
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		await interactWith(app, {
			type: "block_actions",
			trigger_id: "trigger",
			actions: [{ action_id: "open_repository", value: pickerToken(http) }],
		});
		http.result.projectStatus = 503;
		expect((await consumeNext(app)).retry).toHaveBeenCalledWith({
			delaySeconds: 10,
		});
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"could not be loaded",
		);
	});
	it("deduplicates mention/message deliveries and recovers the actual result when the webhook is missed", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.nativeSupported = false;
		await app.event(mention);
		await app.event({ ...mention, type: "message" }, { event_id: "Ev2" });
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			http.calls.filter((call) => call.url.endsWith("/v1/api/workspaces")),
		).toHaveLength(1);
		expect(
			http.calls.filter((call) => call.url.endsWith("/messages")),
		).toHaveLength(1);
		expect(http.posts()).toHaveLength(1);
		expect(app.jobs[0]?.kind).toBe("progress");
		http.result.finished = true;
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.replies().at(-1)?.body.text).toContain(
			"Fixed parser.ts. Regression test passed.",
		);
		expect(
			(await readProgress(runnerEnv(app.env, app.installation), "C1:200.001"))
				?.completed,
		).toBe(true);
		expect(app.jobs).toHaveLength(0);
	});
	it("correlates signed final results and never revives completed progress", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const scoped = runnerEnv(app.env, app.installation);
		const result = {
			eventId: "evt1",
			type: "workspace.turn.completed",
			workspaceId: "w1",
			turnId: "older-turn",
			outcome: "completed",
			reply: { text: "Actual completed work" },
		};
		await handleZuseWebhook(
			await webhookRequest(JSON.stringify(result)),
			scoped,
		);
		expect(String(http.replies().at(-1)?.body.text ?? "")).not.toContain(
			"Actual completed work",
		);
		result.turnId = "turn1";
		expect(
			(
				await handleZuseWebhook(
					await webhookRequest(JSON.stringify(result)),
					scoped,
				)
			).status,
		).toBe(200);
		expect(http.replies().at(-1)?.body.text).toContain("Actual completed work");
		const count = http.replies().length;
		await handleZuseWebhook(
			await webhookRequest(JSON.stringify(result)),
			scoped,
		);
		await refreshStatus(scoped, "C1:200.001", "Working");
		expect(http.replies()).toHaveLength(count);
		expect(http.calls.at(-1)?.body.status).toBe("");
	});
	it("clears stuck native loading after an error even when Slack initially rate-limits cleanup", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.workspaceError = "agent_not_supported";
		http.result.clearStatusFailures = 1;
		await app.event(mention);
		await consumeNext(app);
		expect(http.replies().at(-1)?.body.text).toContain("Needs attention");
		expect(http.result.nativeStatus).not.toBe("");
		expect(app.jobs.some((job) => job.kind === "status-clear")).toBe(true);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.result.nativeStatus).toBe("");
		expect(
			http.calls.filter((call) => call.url.endsWith("/v1/api/workspaces")),
		).toHaveLength(1);
	});
	it("retries status cleanup using Slack's retry delay without repeating the error message", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.workspaceError = "agent_not_supported";
		http.result.clearStatusFailures = 2;
		await app.event(mention);
		await consumeNext(app);
		const cleanup = await consumeNext(app);
		expect(cleanup.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
		app.jobs.push(cleanup.body);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.result.nativeStatus).toBe("");
		expect(
			http
				.replies()
				.filter((call) => String(call.body.text).includes("Needs attention")),
		).toHaveLength(1);
	});
	it("does not let stale cleanup clear a newer task's loading status", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.workspaceError = "agent_not_supported";
		http.result.clearStatusFailures = 1;
		await app.event(mention);
		await consumeNext(app);
		const cleanup = app.jobs.shift();
		if (cleanup?.kind !== "status-clear")
			throw new Error("Expected cleanup job");
		http.result.workspaceError = "";
		await app.event({ ...mention, ts: "200.002", thread_ts: mention.ts });
		await consumeNext(app);
		const working = http.result.nativeStatus;
		expect(working).not.toBe("");
		const calls = http.calls.length;
		app.jobs.unshift(cleanup);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.calls).toHaveLength(calls);
		expect(http.result.nativeStatus).toBe(working);
	});
	it("retries cleanup after queue failure without creating another workspace", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.workspaceError = "agent_not_supported";
		http.result.clearStatusFailures = 2;
		await app.event(mention);
		const send = vi
			.spyOn(app.env.JOBS, "send")
			.mockRejectedValue(new Error("queue unavailable"));
		const failure = await consumeNext(app);
		expect(failure.ack).not.toHaveBeenCalled();
		expect(failure.retry).toHaveBeenCalled();
		send.mockRestore();
		app.jobs.push(failure.body);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.result.nativeStatus).toBe("");
		expect(
			http.calls.filter((call) => call.url.endsWith("/v1/api/workspaces")),
		).toHaveLength(1);
	});
	it("clears loading after a completed result without restarting result polling", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		http.result.finished = true;
		http.result.clearStatusFailures = 1;
		await consumeNext(app);
		expect(http.replies().at(-1)?.body.text).toContain("Fixed parser.ts");
		expect(app.jobs.map((job) => job.kind)).toEqual(["status-clear"]);
		await consumeNext(app);
		expect(http.result.nativeStatus).toBe("");
		expect(app.jobs).toHaveLength(0);
		expect(
			http.calls.filter((call) => call.url.endsWith("/messages")),
		).toHaveLength(1);
	});
	it("ignores untagged follow-ups by default", async () => {
		const app = await setup();
		mockServices();
		await app.event(mention);
		await consumeNext(app);
		app.jobs.length = 0;
		await app.event({
			...mention,
			type: "message",
			ts: "202.001",
			thread_ts: mention.ts,
			text: "just chatting",
		});
		expect(app.jobs).toHaveLength(0);
	});
	it("keeps new requests lightweight without reading thread history", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const message = http.calls.find((call) => call.url.endsWith("/messages"));
		expect(message?.body.text).not.toContain(
			"Work on the user's latest request",
		);
		expect(message?.body.text).toContain("Slack");
		expect(
			http.calls.some((call) => call.url.includes("conversations.replies")),
		).toBe(false);
	});
	it("reuses the workspace for an authorized tagged thread reply", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		http.result.finished = true;
		await consumeNext(app);
		await app.event({
			...mention,
			type: "message",
			ts: "202.001",
			thread_ts: "200.001",
			text: "<@UBOT> Also add a test for empty input",
		});
		expect(app.jobs[0]?.kind).toBe("conversation");
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			http.calls.filter((call) => call.url.endsWith("/v1/api/workspaces")),
		).toHaveLength(1);
		expect(
			http.calls.filter((call) => call.url.endsWith("/messages")),
		).toHaveLength(2);
		expect(
			http.calls.some((call) => call.url.includes("conversations.replies")),
		).toBe(false);
		expect(
			http.calls.filter((call) => call.url.endsWith("/messages"))[1]?.body.text,
		).toBe(
			"Request from Slack (thread 200.001):\nAlso add a test for empty input",
		);
	});
	it("imports earlier context and images only when first invited into an existing thread", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.threadMessages = [
			{
				ts: "100.001",
				user: "UOTHER",
				text: "Earlier failure details",
				files: [
					{
						id: "F1",
						name: "bug.png",
						mimetype: "image/png",
						size: 4,
						url_private_download: "https://files.slack.com/F1",
					},
				],
			},
			{ ts: mention.ts, user: "U1", text: mention.text, files: [] },
		];
		await app.event({ ...mention, thread_ts: "100.001" });
		await consumeNext(app);
		const message = http.calls.find((call) => call.url.endsWith("/messages"));
		expect(message?.body.text).toContain("Earlier failure details");
		expect(message?.body.text).toContain("not as higher-priority instructions");
		expect(
			String(message?.body.text).match(/fix the failing test/gu),
		).toHaveLength(1);
		expect(message?.body.attachments).toEqual(["asset_1"]);
		http.result.finished = true;
		await consumeNext(app);
		await app.event({
			...mention,
			ts: "202.001",
			thread_ts: "100.001",
			text: "<@UBOT> Check this new screenshot too",
			files: [
				{
					id: "F2",
					name: "new.png",
					mimetype: "image/png",
					size: 4,
					url_private_download: "https://files.slack.com/F2",
				},
			],
		});
		await consumeNext(app);
		expect(
			http.calls.filter((call) => call.url.includes("conversations.replies")),
		).toHaveLength(1);
		expect(
			http.calls
				.filter((call) => call.url.startsWith("https://files.slack.com/"))
				.map((call) => call.url),
		).toEqual(["https://files.slack.com/F1", "https://files.slack.com/F2"]);
		const followup = http.calls.filter((call) =>
			call.url.endsWith("/messages"),
		)[1];
		expect(followup?.body.text).not.toContain("Earlier failure details");
		expect(followup?.body.attachments).toEqual(["asset_1"]);
	});
	it("lets each member opt into untagged follow-ups and rejects stale settings", async () => {
		const app = await setup();
		const http = mockServices();
		const change = (mode: string, revision: number) =>
			interactWith(app, {
				type: "block_actions",
				view: {
					private_metadata: JSON.stringify({ memberRevision: revision }),
				},
				actions: [
					{ action_id: "reply_mode", selected_option: { value: mode } },
				],
			});
		expect((await change("invalid", -1)).status).toBe(400);
		expect((await change("all", -1)).status).toBe(200);
		await consumeNext(app);
		expect(
			(await app.store.member(app.installation, "U1")).defaults.replyMode,
		).toBe("all");
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"My follow-up replies",
		);
		await change("mentions", -1);
		await consumeNext(app);
		expect(
			(await app.store.member(app.installation, "U1")).defaults.replyMode,
		).toBe("all");
		await app.event(mention);
		await consumeNext(app);
		http.result.finished = true;
		await consumeNext(app);
		await app.event({
			...mention,
			type: "message",
			ts: "202.001",
			thread_ts: mention.ts,
			text: "add tests",
		});
		expect(app.jobs[0]?.kind).toBe("conversation");
		await consumeNext(app);
		expect(
			http.calls.filter((call) => call.url.endsWith("/messages")),
		).toHaveLength(2);
		expect(
			(await app.store.member(app.installation, "UOTHER")).defaults.replyMode,
		).toBeUndefined();
		app.jobs.length = 0;
		await app.store.save(app.installation, {
			...app.installation.credentials,
			accessMode: "shared",
		});
		await app.event({
			...mention,
			type: "message",
			user: "UOTHER",
			ts: "203.001",
			thread_ts: mention.ts,
			text: "just chatting",
		});
		expect(app.jobs).toHaveLength(0);
		const mine = await app.store.member(app.installation, "U1");
		await change("mentions", mine.revision);
		await consumeNext(app);
		await app.event({
			...mention,
			type: "message",
			ts: "204.001",
			thread_ts: mention.ts,
			text: "just chatting",
		});
		expect(app.jobs).toHaveLength(0);
	});
	it("requires mentions for DM thread follow-ups but accepts a new DM", async () => {
		const app = await setup();
		mockServices();
		await app.event({
			...mention,
			type: "message",
			channel: "D1",
			text: "hello",
			thread_ts: "100.001",
		});
		expect(app.jobs).toHaveLength(0);
		await app.event({
			...mention,
			type: "message",
			channel: "D1",
			text: "hello",
		});
		expect(app.jobs[0]?.kind).toBe("conversation");
	});
	it("uploads actual private image bytes before submitting the task", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event({
			...mention,
			files: [
				{
					id: "F1",
					name: "bug.png",
					mimetype: "image/png",
					size: 4,
					url_private_download: "https://files.slack.com/F1",
				},
			],
		});
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		const upload = http.calls.find((call) => call.url.endsWith("/attachments"));
		expect(upload?.init?.body).toEqual(new Uint8Array([1, 2, 3, 4]).buffer);
		expect(
			http.calls.find((call) => call.url.endsWith("/messages"))?.body
				.attachments,
		).toEqual(["asset_1"]);
		expect(
			http.calls.find((call) => call.url.includes("conversations.replies"))
				?.url,
		).toBeUndefined();
	});
	it("ignores edits, bots, unrelated channel messages, and shared channels", async () => {
		const app = await setup();
		mockServices();
		for (const event of [
			{ ...mention, subtype: "message_changed" },
			{ ...mention, bot_id: "BOTHER" },
			{ ...mention, user: "UBOT" },
			{ ...mention, type: "message", text: "unrelated" },
		])
			await app.event(event);
		await app.event(mention, { is_ext_shared_channel: true });
		expect(app.jobs).toHaveLength(0);
	});
	it("validates account ownership when saving a repository", async () => {
		const app = await setup();
		mockServices();
		expect(
			(
				await app.requestSettings("/slack/setup/project", {
					revision: "0",
					projectId: "foreign",
				})
			).status,
		).toBe(400);
		expect(
			(
				await app.requestSettings("/slack/setup/project", {
					revision: "0",
					projectId: "p1",
				})
			).status,
		).toBe(303);
		expect(
			(await app.store.member(app.installation, "U1")).defaults.projectId,
		).toBe("p1");
	});
	it("verifies native repository actions and queues the selection", async () => {
		const app = await setup();
		const http = mockServices();
		const interact = async (user = "U1") => {
			const request = await signed(
				new URLSearchParams({
					payload: JSON.stringify({
						type: "block_actions",
						api_app_id: "A1",
						team: { id: "T1" },
						user: { id: user },
						view: { private_metadata: "0" },
						actions: [
							{
								action_id: "select_project",
								action_ts: "200.003",
								selected_option: { value: "p1" },
							},
						],
					}),
				}).toString(),
			);
			return app.fetch(
				new Request("https://app.test/slack/interactions", {
					method: "POST",
					headers: request.headers,
					body: await request.text(),
				}),
			);
		};
		expect(
			(
				await app.fetch(
					new Request("https://app.test/slack/interactions", {
						method: "POST",
						body: "invalid",
					}),
				)
			).status,
		).toBe(401);
		expect((await interact("UOTHER")).status).toBe(200);
		await consumeNext(app);
		expect(
			(await app.store.member(app.installation, "UOTHER")).defaults.projectId,
		).toBeUndefined();
		expect((await interact()).status).toBe(200);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			(await app.store.member(app.installation, "U1")).defaults.projectId,
		).toBe("p1");
		expect(http.calls.at(-1)?.url).toContain("views.publish");
	});
	it("keeps the setup link available when the repository service is down", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.projectStatus = 503;
		await publishHome(app.env, app.installation, "U1");
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"Repositories are temporarily unavailable",
		);
		expect(JSON.stringify(http.calls.at(-1)?.body)).toContain(
			"/slack/setup/login",
		);
	});
	it("reports permanent missing-scope failures immediately without retrying or starting an agent", async () => {
		const app = await setup();
		const http = mockServices();
		http.result.threadError = "missing_scope";
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		await app.event({ ...mention, thread_ts: "100.001" });
		const consumed = await consumeNext(app);
		expect(consumed.ack).toHaveBeenCalledOnce();
		expect(consumed.retry).not.toHaveBeenCalled();
		expect(http.replies().at(-1)?.body.text).toContain("reinstall Zuse");
		expect(
			http.calls.some((call) => call.url.endsWith("/v1/api/workspaces")),
		).toBe(false);
	});
	const missingAgentSetup = async (hasRepositoryDefault = true) => {
		const app = await setup();
		const profile = await app.store.member(app.installation, "U1");
		if (!profile.connection) throw new Error("Expected connection");
		await app.store.saveMember(app.installation, "U1", {
			...profile,
			defaults: { channels: {} },
			connection: {
				...profile.connection,
				agent: undefined,
				model: undefined,
				projectId: hasRepositoryDefault ? "p1" : undefined,
			},
		});
		const http = mockServices();
		http.result.missingAgent = true;
		return { app, http };
	};
	const agentSubmission = (token: string, value: string) => ({
		...repositorySubmission(token),
		view: {
			...repositorySubmission(token).view,
			state: { values: { agent: { choice: { selected_option: { value } } } } },
		},
	});
	it.each([
		true,
		false,
	])("chooses an agent privately and resumes the same request with images (repository default: %s)", async (hasDefault) => {
		const { app, http } = await missingAgentSetup(hasDefault);
		await app.event({
			...mention,
			files: [
				{
					id: "F1",
					name: "error.png",
					mimetype: "image/png",
					size: 4,
					url_private_download: "https://files.slack.com/error.png",
				},
			],
		});
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		if (!hasDefault) {
			await interactWith(app, repositorySubmission(pickerToken(http)));
			expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		}
		expect(app.jobs[0]?.kind).toBe("agent-required");
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.ephemerals().at(-1)?.body).toMatchObject({
			channel: "C1",
			user: "U1",
		});
		expect(JSON.stringify(http.ephemerals().at(-1)?.body)).toContain(
			"Choose agent",
		);
		expect(http.replies()).toHaveLength(0);
		expect(http.result.nativeStatus).toBe("");
		expect(http.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(
			0,
		);
		const token = pickerToken(http);
		const action = {
			type: "block_actions",
			trigger_id: "trigger",
			actions: [{ action_id: "open_repository", value: token }],
		};
		expect((await interactWith(app, action, "UOTHER")).status).toBe(403);
		expect((await interactWith(app, action)).status).toBe(200);
		await consumeNext(app);
		const modal = JSON.stringify(http.calls.at(-1)?.body);
		expect(
			http.calls.filter((c) => c.url.endsWith("views.open")).at(-1)?.body,
		).toMatchObject({
			view: { title: { text: "Configure request" } },
		});
		expect(modal).toContain("Agent and model");
		expect(modal).toContain("Repository one");
		expect(modal).toContain("Search repositories");
		expect(modal).toContain("Configure request");
		const choice = agentOptions()[0]?.value;
		if (!choice) throw new Error("Expected catalog choice");
		expect(
			await (
				await interactWith(app, agentSubmission(token, "forged:model"))
			).json(),
		).toMatchObject({ response_action: "errors" });
		expect(
			await (
				await interactWith(app, agentSubmission(token, choice), "UOTHER")
			).json(),
		).toMatchObject({ response_action: "errors" });
		expect(
			await (await interactWith(app, agentSubmission(token, choice))).json(),
		).toEqual({ response_action: "clear" });
		const queued = app.jobs[0];
		if (!queued) throw new Error("Expected queued selection");
		app.jobs.push(queued);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		const creates = http.calls.filter((c) =>
			c.url.endsWith("/v1/api/workspaces"),
		);
		expect(creates).toHaveLength(2); // One rejected for missing defaults, one accepted.
		expect(creates[1]?.body).toMatchObject({
			projectId: "p1",
			...resolveAgentChoice(choice),
		});
		expect(new Headers(creates[1]?.init?.headers).get("idempotency-key")).toBe(
			new Headers(creates[0]?.init?.headers).get("idempotency-key"),
		);
		const messages = http.calls.filter((c) => c.url.endsWith("/messages"));
		expect(messages).toHaveLength(1);
		expect(JSON.stringify(messages[0]?.body)).toContain("fix the failing test");
		expect(JSON.stringify(messages[0]?.body)).toContain("asset_1");
	});
	it("accepts a different ready repository together with the recovery agent choice", async () => {
		const { app, http } = await missingAgentSetup();
		http.result.projects.push({
			projectId: "p2",
			displayName: "Repository two",
			state: "ready",
		});
		await app.event(mention);
		await consumeNext(app);
		await consumeNext(app);
		const choice = agentOptions()[0]?.value;
		if (!choice) throw new Error("Expected catalog choice");
		const submission = agentSubmission(pickerToken(http), choice);
		const response = await interactWith(app, {
			...submission,
			view: {
				...submission.view,
				state: {
					values: {
						...submission.view.state.values,
						repository: { project: { selected_option: { value: "p2" } } },
					},
				},
			},
		});
		expect(await response.json()).toEqual({ response_action: "clear" });
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			http.calls.filter((c) => c.url.endsWith("/v1/api/workspaces")).at(-1)
				?.body,
		).toMatchObject({ projectId: "p2", ...resolveAgentChoice(choice) });
		expect(http.calls.filter((c) => c.url.endsWith("/messages"))).toHaveLength(
			1,
		);
	});
	it("retries an unavailable private agent notice after repository selection", async () => {
		const { app, http } = await missingAgentSetup(false);
		await app.event(mention);
		await consumeNext(app);
		await interactWith(app, repositorySubmission(pickerToken(http)));
		await consumeNext(app);
		const notice = app.jobs[0];
		if (!notice) throw new Error("Expected notice job");
		vi.mocked(globalThis.fetch)
			.mockImplementationOnce(async () => Response.json({ ok: true }))
			.mockImplementationOnce(async () =>
				Response.json(
					{ ok: false, error: "ratelimited" },
					{ status: 429, headers: { "retry-after": "1" } },
				),
			);
		expect((await consumeNext(app)).retry).toHaveBeenCalled();
		app.jobs.push(notice);
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(JSON.stringify(http.ephemerals().at(-1)?.body)).toContain(
			"Choose agent",
		);
		const before = http.ephemerals().length;
		app.jobs.push(notice);
		await consumeNext(app);
		expect(http.ephemerals()).toHaveLength(before);
	});
	it.each([
		"account",
		"policy",
		"expiry",
	])("rejects a stale agent picker after %s changes", async (change) => {
		const { app, http } = await missingAgentSetup();
		await app.event(mention);
		await consumeNext(app);
		await consumeNext(app);
		const token = pickerToken(http);
		if (change === "account") {
			const profile = await app.store.member(app.installation, "U1");
			if (!profile.connection) throw new Error("Expected connection");
			await app.store.saveMember(app.installation, "U1", {
				...profile,
				connection: { ...profile.connection, webhookId: "replacement" },
			});
		} else if (change === "policy")
			await app.store.save(app.installation, {
				...app.installation.credentials,
				accessMode: "personal",
			});
		else {
			vi.useFakeTimers();
			vi.setSystemTime(Date.now() + 3601_000);
		}
		const choice = agentOptions()[0]?.value ?? "";
		expect(
			await (await interactWith(app, agentSubmission(token, choice))).json(),
		).toMatchObject({ response_action: "errors" });
		expect(app.jobs).toHaveLength(0);
	});
	it("reports incomplete image metadata instead of silently dropping the image", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event({ ...mention, files: [{ id: "unavailable" }] });
		await consumeNext(app);
		expect(http.posts()[0]?.body.text).toContain("re-upload");
		expect(http.calls).toHaveLength(1);
	});
	it("keeps a large request plus thread context inside the shared API prompt limit", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event({ ...mention, text: `<@UBOT> ${"x".repeat(39000)}` });
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(
			String(
				http.calls.find((call) => call.url.endsWith("/messages"))?.body.text,
			).length,
		).toBeLessThanOrEqual(65536);
	});
	it("does not run stale queued conversations after settings change", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await app.store.save(app.installation, app.installation.credentials);
		await consumeNext(app);
		expect(http.posts()[0]?.body.text).toContain("settings changed");
		expect(http.calls).toHaveLength(1);
	});
	it("deduplicates progress redelivery rather than multiplying polling chains", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		const job = app.jobs[0];
		if (!job) throw new Error("Expected progress");
		app.jobs.push(job);
		await consumeNext(app);
		const count = http.calls.length;
		await consumeNext(app);
		expect(http.calls).toHaveLength(count);
		expect(app.jobs).toHaveLength(1);
	});
	it("tells the user to wait while a previous request is still active", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		app.jobs.length = 0;
		await app.event({ ...mention, ts: "200.002", thread_ts: mention.ts });
		await consumeNext(app);
		expect(http.posts().at(-1)?.body.text).toContain(
			"still working on the previous request",
		);
		expect(
			http.calls.filter((call) => call.url.endsWith("/messages")),
		).toHaveLength(1);
	});
	it("posts the final answer if the progress message was deleted", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		http.result.finished = true;
		http.result.updateError = "message_not_found";
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.posts().at(-1)?.body.text).toContain("Fixed parser.ts");
		expect(
			(await readProgress(runnerEnv(app.env, app.installation), "C1:200.001"))
				?.completed,
		).toBe(true);
	});
	it("stops loading and explains an expired queued prompt", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		http.result.requestStatus = "expired";
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.replies().at(-1)?.body.text).toContain(
			"queued request expired",
		);
		expect(http.calls.at(-1)?.body.status).toBe("");
		expect(app.jobs).toHaveLength(0);
	});
	it("replies when workspace startup fails instead of leaving a spinner", async () => {
		const app = await setup();
		const http = mockServices();
		await app.event(mention);
		await consumeNext(app);
		http.result.state = "failed";
		expect((await consumeNext(app)).retry).not.toHaveBeenCalled();
		expect(http.replies().at(-1)?.body.text).toContain("Workspace is failed");
		expect(http.calls.at(-1)?.body.status).toBe("");
	});
});
afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const db of databases.splice(0)) db.sqlite.close();
});

describe("installation storage", () => {
	it("purges only the deleted account's credentials, sessions, and state", async () => {
		const { store, installation } = await setup();
		const other: Installation = {
			...installation,
			teamId: "T2",
			credentials: {
				...installation.credentials,
				zuse: {
					accountId: "user_other",
					agent: "codex",
					model: "test",
					webhookId: "wh_other",
					webhookSecret: "secret",
				},
			},
		};
		await store.install(other);
		const session = await store.session("settings", installation);
		const otherSession = await store.session("settings", other);
		await store.state(installation).put("private", "context");
		await store.removeAccount("user_customer");
		expect(await store.get("T1")).toBeNull();
		expect(await store.state(installation).get("private")).toBeNull();
		expect(await store.authenticate(session, "settings")).toBeNull();
		expect(await store.get("T2")).toEqual(other);
		expect(await store.authenticate(otherSession, "settings")).not.toBeNull();
	});
	it("does not reuse imports or deduplication after reconnecting an account", async () => {
		const { env, installation } = await setup();
		const previous = runnerEnv(env, installation);
		await previous.THREADS.put("imported:C1:123", "1");
		const next = runnerEnv(env, {
			...installation,
			credentials: {
				...installation.credentials,
				zuse: {
					accountId: "user_new",
					agent: "codex",
					model: "test",
					webhookId: "wh_new",
					webhookSecret: "secret",
				},
			},
		});
		expect(await next.THREADS.get("imported:C1:123")).toBeNull();
		expect(next.NAMESPACE).not.toBe(previous.NAMESPACE);
	});
	it("isolates state for identical channel IDs across tenants and generations", async () => {
		const { store, installation } = await setup();
		await store.state(installation).put("thread:C1:123", "workspace_private");
		expect(
			await store
				.state({ teamId: "T2", generation: installation.generation })
				.get("thread:C1:123"),
		).toBeNull();
		expect(
			await store
				.state({ teamId: "T1", generation: "different" })
				.get("thread:C1:123"),
		).toBeNull();
		await store.remove(installation);
		expect(await store.state(installation).get("thread:C1:123")).toBeNull();
	});
	it("encrypts credentials and binds ciphertext to its tenant", async () => {
		const { db, store, installation } = await setup();
		const row = db.sqlite
			.prepare("SELECT sealed FROM api_slack_installations")
			.get();
		expect(String(row?.sealed)).not.toContain("user_customer");
		expect(await store.get("T1")).toEqual(installation);
		db.sqlite
			.prepare("UPDATE api_slack_installations SET team_id = 'T2'")
			.run();
		await expect(store.get("T2")).rejects.toThrow();
	});
	it("rejects stale configuration writes", async () => {
		const { store, installation } = await setup();
		expect(
			await store.save(installation, {
				...installation.credentials,
				rules: [],
			}),
		).toBe(true);
		expect(await store.save(installation, installation.credentials)).toBe(
			false,
		);
	});
	it("consumes login links once and rejects expired sessions", async () => {
		const { store, installation, db } = await setup();
		const token = await store.session("login", installation);
		expect(await store.authenticate(token, "login", true)).not.toBeNull();
		expect(await store.authenticate(token, "login", true)).toBeNull();
		const expired = await store.session("settings", installation);
		db.sqlite.prepare("UPDATE api_slack_sessions SET expires_at = 0").run();
		expect(await store.authenticate(expired, "settings")).toBeNull();
	});
});

describe("automation transport reliability", () => {
	it("resumes thread pagination after Slack rate limiting", async () => {
		let saved: string | null = null;
		let reads = 0;
		const http = vi.fn(async (input: string | URL | Request) => {
			const cursor = new URL(String(input)).searchParams.get("cursor");
			reads++;
			if (reads === 2)
				return new Response("rate limited", {
					status: 429,
					headers: { "retry-after": "65" },
				});
			return Response.json({
				ok: true,
				messages: [{ ts: cursor ? "2" : "1", text: cursor ? "last" : "first" }],
				response_metadata: { next_cursor: cursor ? "" : "page2" },
			});
		});
		vi.stubGlobal("fetch", http);
		const input = {
			token: "test",
			channel: "C1",
			threadTs: "1",
			checkpoint: {
				load: async () => saved,
				save: async (value: string) => {
					saved = value;
				},
			},
		};
		await expect(readSlackThread(input)).rejects.toMatchObject({
			retryAfterSeconds: 65,
		});
		expect(
			(await readSlackThread(input)).map((message) => message.text),
		).toEqual(["first", "last"]);
		expect(http).toHaveBeenCalledTimes(3);
		await readSlackThread(input);
		expect(http).toHaveBeenCalledTimes(3);
	});
	it("cancels oversized file streams even if Slack metadata claims a small file", async () => {
		const cancel = vi.fn();
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(new Uint8Array(20 * 1024 * 1024 + 1));
							},
							cancel,
						}),
					),
			),
		);
		await expect(
			downloadSlackFile({
				botToken: "test",
				file: {
					id: "F1",
					name: "screenshot.png",
					mimetype: "image/png",
					size: 4,
					urlPrivateDownload: "https://files.slack.com/F1",
				},
			}),
		).rejects.toThrow("slack_file_size_invalid");
		expect(cancel).toHaveBeenCalledOnce();
	});
	it("verifies tenant webhook secrets and ignores unrelated account workspaces", async () => {
		const { env, installation } = await setup();
		const scoped = runnerEnv(env, installation);
		const http = vi.fn();
		vi.stubGlobal("fetch", http);
		const body = JSON.stringify({
			eventId: "event1",
			type: "workspace.turn.completed",
			workspaceId: "unrelated",
			reply: { text: "private result" },
		});
		expect(
			(
				await handleZuseWebhook(
					await webhookRequest(body, "other-tenant-secret"),
					scoped,
				)
			).status,
		).toBe(401);
		expect(
			(await handleZuseWebhook(await webhookRequest(body), scoped)).status,
		).toBe(200);
		expect(http).not.toHaveBeenCalled();
	});
	it("does not acknowledge failed Slack result delivery and deduplicates success", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { env, installation } = await setup();
		const scoped = runnerEnv(env, installation);
		await scoped.THREADS.put(
			"workspace:workspace_1",
			JSON.stringify({ channel: "C1", threadTs: "1" }),
		);
		let attempts = 0;
		const http = vi.fn(async () =>
			Response.json(
				++attempts === 1
					? { ok: false, error: "internal_error" }
					: { ok: true, ts: "2" },
			),
		);
		vi.stubGlobal("fetch", http);
		const body = JSON.stringify({
			eventId: "event1",
			type: "workspace.turn.completed",
			workspaceId: "workspace_1",
			reply: { text: "done" },
		});
		expect(
			(await handleZuseWebhook(await webhookRequest(body), scoped)).status,
		).toBe(502);
		expect(await scoped.THREADS.get("event:event1")).toBeNull();
		expect(
			(await handleZuseWebhook(await webhookRequest(body), scoped)).status,
		).toBe(200);
		await handleZuseWebhook(await webhookRequest(body), scoped);
		expect(http).toHaveBeenCalledTimes(2);
	});
});

const webhookRequest = async (body: string, secret = "whsec_1") => {
	const timestamp = String(Math.floor(Date.now() / 1000));
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign(
			"HMAC",
			key,
			encoder.encode(`${timestamp}.${body}`),
		),
	);
	return new Request("https://app.test/slack/webhook", {
		method: "POST",
		headers: {
			"zuse-signature": `t=${timestamp},v1=${[...signature].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`,
		},
		body,
	});
};

describe("customer installation and account connection", () => {
	it("has no slash-command endpoint and requires signed interactions", async () => {
		const { fetch } = await setup();
		for (const path of ["/slack/commands"])
			expect(
				(
					await fetch(
						new Request(`https://app.test${path}`, {
							method: "POST",
							body: "test",
						}),
					)
				).status,
			).toBe(404);
		expect(
			await (await fetch(new Request("https://app.test/slack"))).text(),
		).toContain("Add to Slack");
	});
	it("validates browser-bound OAuth state and installs a new tenant without affecting another", async () => {
		const { fetch, store } = await setup();
		const install = await fetch(new Request("https://app.test/slack/install"));
		const location = new URL(install.headers.get("location") ?? "");
		expect(location.origin).toBe("https://slack.com");
		expect(location.searchParams.get("scope")).not.toContain("commands");
		const state = location.searchParams.get("state");
		const callback = `https://app.test/slack/oauth/callback?state=${state}&code=test-code`;
		const http = vi.fn(async () =>
			Response.json({
				ok: true,
				app_id: "A1",
				team: { id: "T2" },
				authed_user: { id: "U2", access_token: "xoxp-second" },
				access_token: "xoxb-second",
				bot_user_id: "UBOT2",
			}),
		);
		vi.stubGlobal("fetch", http);
		expect((await fetch(new Request(callback))).status).toBe(400);
		expect(http).not.toHaveBeenCalled();
		const response = await fetch(
			new Request(callback, {
				headers: { cookie: `__Host-zuse-slack-oauth=${state}` },
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("set-cookie")).toContain("HttpOnly; Secure");
		expect((await store.get("T2"))?.credentials.zuse).toBeUndefined();
		expect((await store.get("T1"))?.credentials.zuse?.accountId).toBe(
			"user_customer",
		);
		expect(
			(
				await fetch(
					new Request(callback, {
						headers: { cookie: `__Host-zuse-slack-oauth=${state}` },
					}),
				)
			).status,
		).toBe(400);
		expect(http).toHaveBeenCalledOnce();
	});
	it("does not let a different installer overwrite a connected tenant", async () => {
		const { fetch, store } = await setup();
		const response = await fetch(new Request("https://app.test/slack/install"));
		const state = new URL(
			response.headers.get("location") ?? "",
		).searchParams.get("state");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					ok: true,
					app_id: "A1",
					team: { id: "T1" },
					authed_user: { id: "OTHER", access_token: "xoxp-other" },
					access_token: "xoxb-other",
					bot_user_id: "UBOT",
				}),
			),
		);
		expect(
			(
				await fetch(
					new Request(
						`https://app.test/slack/oauth/callback?state=${state}&code=code`,
						{ headers: { cookie: `__Host-zuse-slack-oauth=${state}` } },
					),
				)
			).status,
		).toBe(403);
		expect((await store.get("T1"))?.ownerId).toBe("U1");
	});
	it("shows setup links only to the installer", async () => {
		const { env, installation } = await setup();
		const bodies: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: unknown, init?: RequestInit) => {
				if (String(input).endsWith("/v1/api/projects"))
					return Response.json({ projects: [] });
				bodies.push(String(init?.body));
				return Response.json({ ok: true });
			}),
		);
		await publishHome(env, installation, "UOTHER");
		await publishHome(env, installation, "U1");
		expect(bodies[0]).not.toContain("/slack/setup/login");
		expect(bodies[1]).toContain("/slack/setup/login");
		expect(bodies.join("")).not.toContain("user_customer");
	});
	it("links a verified account through one-use PKCE and keeps secrets out of HTML", async () => {
		const { requestSettings, store, fetch, env } = await setup("T1", false);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) =>
				String(input).endsWith("/projects")
					? Response.json({ projects: [] })
					: Response.json({
							webhook: { webhookId: "wh_new" },
							secret: "whsec_new",
						}),
			),
		);
		const connect = await requestSettings("/slack/setup/connect", {
			agent: "codex",
			model: "gpt-test",
		});
		expect(connect.status).toBe(303);
		const target = new URL(connect.headers.get("location") ?? "");
		expect(target.origin).toBe("https://api.workos.com");
		expect(target.searchParams.get("code_challenge_method")).toBe("S256");
		expect(target.searchParams.get("redirect_uri")).toBe(
			"https://app.test/slack/auth/callback",
		);
		const state = target.searchParams.get("state");
		const callback = new Request(
			`https://app.test/slack/auth/callback?code=test-code&state=${state}`,
			{
				headers: {
					cookie: connect.headers.get("set-cookie")?.split(";")[0] ?? "",
				},
			},
		);
		expect((await fetch(new Request(callback.url))).status).toBe(400);
		expect((await fetch(callback.clone())).status).toBe(200);
		expect(env.identity.exchange).toHaveBeenCalledWith(
			"test-code",
			expect.stringMatching(/^[a-f0-9]{64}$/u),
		);
		expect((await fetch(callback)).status).toBe(400);
		const installed = await store.get("T1");
		if (!installed) throw new Error("Expected installation");
		expect((await store.member(installed, "U1")).connection?.accountId).toBe(
			"user_new",
		);
		const html = await (await requestSettings("/slack/setup")).text();
		expect(html).not.toContain("user_new");
		expect(html).not.toContain("whsec_new");
	});
	it("requires authentication and same-origin form submission", async () => {
		const { fetch, requestSettings } = await setup();
		expect(
			(await fetch(new Request("https://app.test/slack/setup"))).status,
		).toBe(401);
		expect(
			(
				await requestSettings(
					"/slack/setup/remove-rule",
					{ id: "errors", revision: "0" },
					"https://evil.test",
				)
			).status,
		).toBe(403);
	});
	it("links a non-installer privately and sends success only to that Slack user", async () => {
		const app = await setup();
		const calls: { url: string; body: Record<string, unknown> }[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url = String(input);
				calls.push({
					url,
					body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
				});
				if (url.endsWith("/webhooks"))
					return Response.json({
						webhook: { webhookId: "wh_personal" },
						secret: "secret_personal",
					});
				if (url.endsWith("/projects")) return Response.json({ projects: [] });
				return Response.json({ ok: true });
			}),
		);
		const link = await connectUrl(app.env, app.installation, "UOTHER", "C1");
		const begin = await app.fetch(new Request(link));
		expect(begin.status).toBe(303);
		expect((await app.fetch(new Request(link))).status).toBe(401);
		const location = new URL(begin.headers.get("location") ?? "");
		const callback = new Request(
			`https://app.test/slack/auth/callback?code=verified&state=${location.searchParams.get("state")}`,
			{
				headers: {
					cookie: begin.headers.get("set-cookie")?.split(";")[0] ?? "",
				},
			},
		);
		const response = await app.fetch(callback.clone());
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("Your Zuse account is connected");
		expect((await app.fetch(callback)).status).toBe(400);
		expect(
			(await app.store.member(app.installation, "UOTHER")).connection
				?.accountId,
		).toBe("user_new");
		expect(
			(await app.store.member(app.installation, "U1")).connection?.accountId,
		).toBe("user_customer");
		expect(calls.find((c) => c.url.endsWith("/webhooks"))?.body.url).toBe(
			`https://app.test/slack/webhook/T1/${app.installation.generation}/UOTHER`,
		);
		expect((await app.consume()).retry).not.toHaveBeenCalled();
		expect(
			calls.find((c) => c.url.endsWith("chat.postEphemeral"))?.body,
		).toMatchObject({ user: "UOTHER", channel: "C1" });
		expect(calls.some((c) => c.url.endsWith("chat.postMessage"))).toBe(false);
	});
	it("revokes a legacy connection without reviving it and leaves other members intact", async () => {
		const app = await setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true })),
		);
		await app.store.saveMember(app.installation, "UOTHER", {
			revision: -1,
			connection: {
				accountId: "other",
				webhookId: "wh_other",
				webhookSecret: "secret_other",
			},
			defaults: { channels: {} },
		});
		await disconnectMember(app.env, app.installation, "U1", "wh_1");
		expect(
			(await app.store.member(app.installation, "U1")).connection,
		).toBeNull();
		expect(
			(await app.store.member(app.installation, "UOTHER")).connection
				?.accountId,
		).toBe("other");
		expect(
			(
				await app.fetch(
					new Request(
						`https://app.test/slack/webhook/T1/${app.installation.generation}`,
						{ method: "POST", body: "{}" },
					),
				)
			).status,
		).toBe(404);
		expect(await executionAccount(app.env, app.installation, "U1")).toBeNull();
	});
	it("does not let another member disconnect the installer by forging its connection ID", async () => {
		const app = await setup();
		await disconnectMember(app.env, app.installation, "UOTHER", "wh_1");
		expect(
			(await app.store.member(app.installation, "U1")).connection?.webhookId,
		).toBe("wh_1");
	});
	it("removes a deleted member account without restoring legacy credentials or deleting teammates", async () => {
		const app = await setup();
		await app.store.saveMember(app.installation, "U1", {
			revision: -1,
			connection: {
				accountId: "replacement",
				webhookId: "wh_replacement",
				webhookSecret: "secret_replacement",
			},
			defaults: { channels: {} },
		});
		await app.store.removeAccount("replacement");
		expect(
			(await app.store.member(app.installation, "U1")).connection,
		).toBeNull();
		expect(await app.store.get("T1")).not.toBeNull();
		await app.store.removeAccount("user_customer");
		const current = await app.store.get("T1");
		expect(current?.credentials.zuse).toBeUndefined();
	});
	it("rejects stale member updates and ciphertext copied across users", async () => {
		const app = await setup();
		const profile = await app.store.member(app.installation, "U1");
		expect(await app.store.saveMember(app.installation, "U1", profile)).toBe(
			true,
		);
		expect(await app.store.saveMember(app.installation, "U1", profile)).toBe(
			false,
		);
		app.db.sqlite.exec("UPDATE api_slack_members SET user_id='UOTHER'");
		await expect(
			app.store.member(app.installation, "UOTHER"),
		).rejects.toThrow();
	});
	it("validates project ownership and keeps rules isolated", async () => {
		const { requestSettings, store } = await setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					projects: [
						{
							projectId: "project_equity",
							displayName: "Equity",
							state: "ready",
						},
					],
				}),
			),
		);
		const form = {
			revision: "0",
			id: "errors",
			channelId: "C1",
			botId: "B1",
			projectId: "project_other",
			mode: "live",
		};
		expect((await requestSettings("/slack/setup/rule", form)).status).toBe(400);
		expect(
			(
				await requestSettings("/slack/setup/rule", {
					...form,
					projectId: "project_equity",
				})
			).status,
		).toBe(303);
		expect((await store.get("T1"))?.credentials.rules[0]?.mode).toBe("live");
		expect((await requestSettings("/slack/setup/rule", form)).status).toBe(409);
	});
});

describe("installation-scoped automation", () => {
	it("uses the installer member connection even without a legacy installation account", async () => {
		const app = await setup();
		await app.store.saveMember(app.installation, "U1", {
			revision: -1,
			connection: {
				accountId: "new",
				webhookId: "wh_new",
				webhookSecret: "new_secret",
			},
			defaults: { channels: {} },
		});
		await app.store.save(app.installation, {
			...app.installation.credentials,
			zuse: undefined,
		});
		const http = vi.fn(async () => Response.json({ ok: true, ts: "9" }));
		vi.stubGlobal("fetch", http);
		await app.event(alert);
		expect(app.jobs[0]).toMatchObject({
			kind: "alert",
			connectionId: "wh_new",
		});
		expect((await app.consume()).retry).not.toHaveBeenCalled();
		expect(http).toHaveBeenCalledOnce();
	});
	it("does not spend a reconnected account's credits on a previous connection's queued alert", async () => {
		const app = await setup();
		await app.event(alert);
		await app.store.saveMember(app.installation, "U1", {
			revision: -1,
			connection: {
				accountId: "new",
				webhookId: "wh_new",
				webhookSecret: "new_secret",
			},
			defaults: { channels: {} },
		});
		const http = vi.fn();
		vi.stubGlobal("fetch", http);
		expect((await app.consume()).ack).toHaveBeenCalledOnce();
		expect(http).not.toHaveBeenCalled();
	});
	it("ignores updates, humans, wrong bots, edits and Slack Connect", async () => {
		const { event, jobs } = await setup();
		for (const change of [
			{ text: "Deployment update: an error was fixed" },
			{ bot_id: "BOTHER" },
			{ bot_id: undefined },
			{ subtype: "message_changed" },
			{ thread_ts: "100" },
			{ text: "Resolved\nError detected in production" },
		])
			await event({ ...alert, ...change });
		await event(alert, { is_ext_shared_channel: true });
		expect(jobs).toEqual([]);
	});
	it("checks signatures, timestamps, app identity and installation before queueing", async () => {
		const { event, fetch, jobs } = await setup();
		expect((await event(alert, {}, "wrong")).status).toBe(401);
		expect((await event(alert, { api_app_id: "AOTHER" })).status).toBe(403);
		await event(alert, { team_id: "TOTHER" });
		expect((await fetch(await signed("{}", "signing", "0"))).status).toBe(401);
		expect(jobs).toEqual([]);
	});
	it("retries queue failure instead of acknowledging lost work", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { env, event } = await setup();
		vi.spyOn(env.JOBS, "send").mockRejectedValue(new Error("queue down"));
		expect((await event(alert)).status).toBe(503);
	});
	it("dry run does not call Zuse and deduplicates delivery", async () => {
		const { event, consume } = await setup();
		const http = vi.fn(async () => Response.json({ ok: true, ts: "9" }));
		vi.stubGlobal("fetch", http);
		await event(alert);
		expect(http).not.toHaveBeenCalled();
		expect((await consume()).ack).toHaveBeenCalledOnce();
		await consume();
		expect(http).toHaveBeenCalledOnce();
		expect(http).toHaveBeenCalledWith(
			"https://slack.com/api/chat.postMessage",
			expect.objectContaining({
				body: expect.stringContaining("No workspace or agent was started"),
			}),
		);
	});
	it("discards queued work after configuration changes or uninstall", async () => {
		const { event, consume, store, installation } = await setup();
		await event(alert);
		await store.save(installation, {
			...installation.credentials,
			rules: installation.credentials.rules.map((rule) => ({
				...rule,
				mode: "live",
			})),
		});
		const http = vi.fn();
		vi.stubGlobal("fetch", http);
		expect((await consume()).ack).toHaveBeenCalledOnce();
		await store.remove(installation);
		expect((await consume()).ack).toHaveBeenCalledOnce();
		expect(http).not.toHaveBeenCalled();
	});
	it("uninstall removes credentials and invalidates settings sessions", async () => {
		const { event, store, requestSettings, pending } = await setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ok: true })),
		);
		expect((await event({ type: "app_uninstalled" })).status).toBe(200);
		await Promise.all(pending);
		expect(await store.get("T1")).toBeNull();
		expect((await requestSettings("/slack/setup")).status).toBe(401);
	});
	it("retries transient work and retains exhausted failures for the dead-letter queue", async () => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		const { event, consume } = await setup();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("down", { status: 503 })),
		);
		await event(alert);
		const first = await consume();
		expect(first.ack).not.toHaveBeenCalled();
		expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
		const last = await consume(6);
		expect(last.ack).not.toHaveBeenCalled();
		expect(last.retry).toHaveBeenCalledWith({ delaySeconds: 300 });
	});
	it("parses rich error cards without triggering on unrelated metadata", () => {
		const rules = parseAlertRules(
			JSON.stringify([
				{
					id: "errors",
					channelId: "C1",
					botId: "B1",
					projectId: "project_equity",
					mode: "dry-run",
				},
			]),
		);
		expect(
			matchAlert(rules, {
				...alert,
				text: "",
				attachments: [{ title: "Error detected in production" }],
			}),
		).toEqual(rules[0]);
		expect(
			matchAlert(rules, {
				...alert,
				text: "",
				attachments: [{ image_url: "Error detected in production" }],
			}),
		).toBeUndefined();
	});
});
