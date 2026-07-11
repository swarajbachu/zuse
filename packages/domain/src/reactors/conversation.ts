import { Effect } from "effect";

import type { ChatEvent } from "../chat/events.js";
import type { SessionEvent } from "../core/events.js";
import type { StoredEvent } from "../engine/dispatch.js";
import type { ReactorDefinition } from "../engine/reactor-runner.js";

export type ProviderStartCommand = {
	readonly _tag: "StartProvider";
	readonly providerStartJson: string;
};

export type ProviderStopCommand = {
	readonly _tag: "StopProvider";
	readonly requestedAt: number;
};

export type AutoNameCommand = { readonly _tag: "AutoNameChat" };

export type ChatArchiveCommand = {
	readonly _tag: "ArchiveChatWorktree";
	readonly force: boolean;
};

export type ChatDeleteCommand = { readonly _tag: "DeleteChatResources" };

export const providerStartReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	ProviderStartCommand
> = {
	name: "provider-start",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "SessionCreated" &&
				record.event.providerStartJson !== undefined
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "StartProvider",
								providerStartJson: record.event.providerStartJson,
							},
						},
					]
				: [],
		),
};

export const providerStopReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	ProviderStopCommand
> = {
	name: "provider-stop",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "ProviderStopRequested"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "StopProvider",
								requestedAt: record.event.requestedAt,
							},
						},
					]
				: [],
		),
};

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
							command: { _tag: "AutoNameChat" },
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
								force: record.event.force,
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
