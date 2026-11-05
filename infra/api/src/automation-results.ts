import { postSlackMessage, SlackApiError, slackApi } from "@zuse/slack/slack";
import { Effect, Option } from "effect";
import type { AutomationMailboxStore } from "./automation-mailbox.ts";
import { serviceUnavailable } from "./errors.ts";
import { SlackPersistence } from "./slack/persistence.ts";
import { workspaceScopeForOwner } from "./workspace-scope.ts";

/** Completion callbacks can only target the original verified event's account/thread. */
export const finishAutomationEvent = Effect.fn("finishAutomationEvent")(
	function* (
		mailbox: AutomationMailboxStore,
		workspaceId: string,
		result: {
			readonly id: string;
			readonly text: string;
			readonly status: string;
		},
	) {
		const slack = yield* Effect.serviceOption(SlackPersistence);
		yield* Effect.tryPromise({
			try: async () => {
				const event = await mailbox.resultEvent(workspaceId, result.id);
				if (!event) return;
				if (event.source === "slack" && Option.isSome(slack)) {
					const { teamId, generation, connectionId, channelId, threadTs } =
						event.context;
					if (teamId && channelId && threadTs) {
						const installation = await slack.value.get(teamId);
						if (installation && installation.generation === generation) {
							const owner = (
								await slack.value.member(installation, installation.ownerId)
							).connection;
							const scope = workspaceScopeForOwner(event.accountId);
							const ownerMatches =
								owner &&
								(scope.kind === "organization"
									? owner.organizationId === scope.organizationId
									: !owner.organizationId &&
										owner.accountId === event.accountId);
							if (ownerMatches && owner.webhookId === connectionId) {
								await postSlackMessage({
									botToken: installation.credentials.botToken,
									channel: channelId,
									threadTs,
									text: result.text || `Automation ${result.status}.`,
									idempotencyKey: `automation-result:${workspaceId}:${result.id}`,
								});
							}
						}
					}
				}
				await mailbox.complete(workspaceId, result.id);
			},
			catch: () => serviceUnavailable("automation_result_delivery_failed"),
		});
	},
);

export const deliverAutomationNotification = Effect.fn(
	"deliverAutomationNotification",
)(function* (
	mailbox: AutomationMailboxStore,
	workspaceId: string,
	input: {
		readonly automationId: string;
		readonly runId: string;
		readonly destination: string;
		readonly text: string;
	},
) {
	const slack = yield* Effect.serviceOption(SlackPersistence);
	if (Option.isNone(slack))
		return yield* serviceUnavailable("slack_not_configured");
	yield* Effect.tryPromise({
		try: async () => {
			const target = await mailbox.notificationTarget(
				workspaceId,
				input.automationId,
				input.destination,
			);
			if (!target)
				throw new Error("automation_notification_destination_rejected");
			if (await target.delivered(input.runId)) return;
			const parts = input.destination.split("/");
			const selectedTeam = parts.length === 2 ? parts[0] : undefined;
			const channel = parts.at(-1) ?? "";
			const teams = await mailbox.slackTeams(target.accountId);
			for (const team of teams) {
				if (selectedTeam && team.team_id !== selectedTeam) continue;
				const installation = await slack.value.get(team.team_id);
				if (!installation) continue;
				const owner = (
					await slack.value.member(installation, installation.ownerId)
				).connection;
				if (owner?.accountId !== target.accountId) continue;
				try {
					// Verify the linked installer can still access this channel using existing history scopes.
					await slackApi(
						installation.credentials.userToken,
						"conversations.history",
						{ channel, limit: 1 },
					);
				} catch (error) {
					if (error instanceof SlackApiError && !error.retryable) continue;
					throw error;
				}
				await postSlackMessage({
					botToken: installation.credentials.botToken,
					channel,
					text: input.text || "Automation completed.",
					idempotencyKey: `automation-notification:${workspaceId}:${input.automationId}:${input.runId}:${input.destination}`,
				});
				await mailbox.notificationDelivered(
					workspaceId,
					input.automationId,
					input.runId,
					input.destination,
				);
				return;
			}
			throw new Error("automation_notification_channel_unavailable");
		},
		catch: () => serviceUnavailable("automation_notification_delivery_failed"),
	});
});
