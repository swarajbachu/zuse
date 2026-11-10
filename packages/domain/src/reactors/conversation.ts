import { Effect } from "effect";

import type { ChatEvent } from "../chat/events.js";
import type { SessionEvent } from "../core/events.js";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ReactorDefinition } from "../engine/reactor-runner.js";

export type AutoNameCommand = {
	readonly _tag: "AutoNameChat";
	/** The turn to name from; null means the session's first user turn. */
	readonly turnId: string | null;
	readonly trigger: AutoNameTrigger;
};

/**
 * - `turn-started`: names right away, unless a new chat still holds its first
 *   turn until its worktree is attached; the release then names both at once.
 * - `startup-released`: that release.
 * - `turn-completed`: retries naming the launch could not do, and may fall
 *   back to the request's own words when the model gives nothing usable.
 */
export type AutoNameTrigger =
	| "turn-started"
	| "startup-released"
	| "turn-completed";

export type ReviewGuideRefreshCommand = {
	readonly _tag: "RefreshReviewGuide";
	readonly turnId: string;
	/** When the turn settled; catch-up skips refreshes long past. */
	readonly settledAt: number | null;
};

export type ChatArchiveCommand = {
	readonly _tag: "ArchiveChatWorktree";
	readonly force: boolean;
};

export type ChatDeleteCommand = { readonly _tag: "DeleteChatResources" };

export const autoNameReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	AutoNameCommand
> = {
	name: "auto-name-chat",
	react: (record) => {
		const command = autoNameCommand(record.event);
		return Effect.succeed(
			command === null ? [] : [{ streamId: record.streamId, command }],
		);
	},
};

/**
 * Name a chat and its branch from the first message as soon as its turn
 * starts, so the branch never sits on a placeholder while the agent works.
 * A completed turn retries naming that was missed; names only apply once.
 */
const autoNameCommand = (event: SessionEvent): AutoNameCommand | null => {
	switch (event._tag) {
		case "TurnStarted":
			return {
				_tag: "AutoNameChat",
				turnId: event.turnId,
				trigger: "turn-started",
			};
		case "SessionQueuePausedSet":
			return event.paused
				? null
				: { _tag: "AutoNameChat", turnId: null, trigger: "startup-released" };
		case "TurnSettled":
			return event.outcome === "completed"
				? {
						_tag: "AutoNameChat",
						turnId: event.turnId,
						trigger: "turn-completed",
					}
				: null;
		default:
			return null;
	}
};

/** A finished turn changed the workspace: its guided review may be stale. */
export const reviewGuideReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	ReviewGuideRefreshCommand
> = {
	name: "review-guide-refresh",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "TurnSettled" &&
				record.event.outcome === "completed"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "RefreshReviewGuide",
								turnId: record.event.turnId,
								settledAt: record.event.settledAt ?? null,
							},
						},
					]
				: [],
		),
};

export const chatArchiveReactorDefinition: ReactorDefinition<
	StoredEvent<ChatEvent>,
	ChatArchiveCommand
> = {
	name: "chat-archive",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "ChatArchiveRequested"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "ArchiveChatWorktree",
								force: record.event.force ?? false,
							},
						},
					]
				: [],
		),
};

export const chatDeleteReactorDefinition: ReactorDefinition<
	StoredEvent<ChatEvent>,
	ChatDeleteCommand
> = {
	name: "chat-delete",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "ChatDeleteRequested"
				? [
						{
							streamId: record.streamId,
							command: { _tag: "DeleteChatResources" },
						},
					]
				: [],
		),
};
