import { resolveAgentChoice } from "./agent-choice.ts";
import { pendingRepository, repositoryLoadingView } from "./repositories.ts";
import { slackApi, verifySlackSignature } from "./slack.ts";
import type { AppEnv, AppJob } from "./types.ts";

export const interactions = async (
	request: Request,
	env: AppEnv,
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
		api_app_id?: string;
		trigger_id?: string;
		team?: { id?: string };
		user?: { id?: string };
		view?: {
			id?: string;
			callback_id?: string;
			private_metadata?: string;
			state?: {
				values?: Record<
					string,
					Record<
						string,
						{
							selected_option?: { value?: string };
							selected_options?: { value?: string }[];
						}
					>
				>;
			};
		};
		actions?: {
			action_id?: string;
			action_ts?: string;
			value?: string;
			selected_option?: { value?: string };
		}[];
	};
	try {
		payload = JSON.parse(new URLSearchParams(rawBody).get("payload") ?? "");
		if (!payload || typeof payload !== "object") throw new Error();
	} catch {
		return new Response("invalid payload", { status: 400 });
	}
	const installation = payload.team?.id
		? await env.store.get(payload.team.id)
		: null;
	const userId = payload.user?.id;
	if (
		!installation ||
		!userId ||
		!/^[UW][A-Z0-9]+$/u.test(userId) ||
		payload.api_app_id !== env.SLACK_APP_ID
	)
		return new Response("forbidden", { status: 403 });
	const action = payload.actions?.[0];
	const identity = {
		teamId: installation.teamId,
		generation: installation.generation,
		id: `interaction:${action?.action_ts ?? payload.view?.id}`,
	};
	if (
		payload.type === "view_submission" &&
		payload.view?.callback_id === "select_repository"
	) {
		const token = payload.view.private_metadata ?? "";
		const errorBlock = payload.view.state?.values?.agent
			? "agent"
			: "repository";
		const selected = await pendingRepository(env, installation, token, userId);
		if (!selected || selected.pending.projectId)
			return Response.json({
				response_action: "errors",
				errors: {
					[errorBlock]:
						"Request expired or account changed. Close and send your task again.",
				},
			});
		// Retain compatibility with agent-only modals already open during a deploy.
		const projectId = payload.view.state?.values?.repository
			? payload.view.state.values.repository.project?.selected_option?.value
			: selected.pending.needsAgent
				? selected.pending.job.projectId
				: undefined;
		const agentChoice =
			payload.view.state?.values?.agent?.choice?.selected_option?.value;
		if (
			(selected.pending.needsAgent || agentChoice !== undefined) &&
			!resolveAgentChoice(agentChoice)
		)
			return Response.json({
				response_action: "errors",
				errors: { agent: "Choose an available agent and model." },
			});
		if (!projectId)
			return Response.json({
				response_action: "errors",
				errors: { repository: "Choose a repository." },
			});
		const remembered =
			payload.view.state?.values?.defaults?.remember?.selected_options ?? [];
		await env.JOBS.send({
			...identity,
			kind: "selection",
			token,
			userId,
			projectId,
			agentChoice,
			viewId: payload.view.id ?? "",
			channelDefault: remembered.some((v) => v.value === "channel"),
			personalDefault: remembered.some((v) => v.value === "personal"),
		});
		return Response.json({ response_action: "clear" });
	}
	if (payload.type !== "block_actions" || !action)
		return new Response("invalid action", { status: 400 });
	if (action.action_id === "connect_account") return new Response("ok"); // The private URL starts browser-bound sign-in.
	if (action.action_id === "open_repository") {
		const token = action.value ?? "";
		if (
			!payload.trigger_id ||
			!(await pendingRepository(env, installation, token, userId))
		)
			return new Response("expired picker", { status: 403 });
		// Trigger IDs expire in three seconds. Open a cheap loading view before queued catalog work.
		const opened = await slackApi(
			installation.credentials.botToken,
			"views.open",
			{ trigger_id: payload.trigger_id, view: repositoryLoadingView(token) },
		);
		const view = opened.view as { id?: string } | undefined;
		if (!view?.id) throw new Error("slack_missing_view_id");
		await env.JOBS.send({
			...identity,
			kind: "picker",
			token,
			userId,
			viewId: view.id,
		});
		return new Response("ok");
	}
	let metadata: { revision?: number; memberRevision?: number };
	try {
		const parsed = JSON.parse(payload.view?.private_metadata ?? "null");
		metadata =
			typeof parsed === "number" ? { revision: parsed } : (parsed ?? {});
	} catch {
		return new Response("invalid view", { status: 400 });
	}
	let job: AppJob;
	if (action.action_id === "select_project" && action.selected_option?.value)
		job = {
			...identity,
			kind: "project",
			userId,
			projectId: action.selected_option.value,
			revision: metadata.revision ?? -1,
			memberRevision: metadata.memberRevision,
		};
	else if (action.action_id === "disconnect_account" && action.value)
		job = {
			...identity,
			kind: "disconnect",
			userId,
			connectionId: action.value,
		};
	else if (action.action_id === "reply_mode") {
		const mode = action.selected_option?.value;
		if (mode !== "mentions" && mode !== "all")
			return new Response("invalid reply mode", { status: 400 });
		job = {
			...identity,
			kind: "reply-mode",
			userId,
			mode,
			memberRevision: metadata.memberRevision ?? -2,
		};
	} else if (action.action_id === "access_mode") {
		if (userId !== installation.ownerId)
			return new Response("forbidden", { status: 403 });
		const mode = action.selected_option?.value;
		if (mode !== "personal" && mode !== "shared" && mode !== "installer")
			return new Response("invalid mode", { status: 400 });
		job = {
			...identity,
			kind: "policy",
			userId,
			mode,
			revision: metadata.revision ?? -1,
		};
	} else return new Response("invalid action", { status: 400 });
	await env.JOBS.send(job);
	return new Response("ok");
};
