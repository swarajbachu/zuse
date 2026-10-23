import { Effect } from "effect";

import type { ChatEvent } from "../chat/events.js";
import type { SessionEvent } from "../core/events.js";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ReactorDefinition } from "../engine/reactor-runner.js";

export type AutoNameCommand = {
	readonly _tag: "AutoNameChat";
	readonly turnId: string;
};

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
	react: (record) =>
		Effect.succeed(
			record.event._tag === "TurnSettled" &&
				record.event.outcome === "completed"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "AutoNameChat",
								turnId: record.event.turnId,
							},
						},
					]
				: [],
		),
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
