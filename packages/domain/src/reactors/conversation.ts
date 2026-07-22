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

export type ProviderTurnCommand = {
	readonly _tag: "SendProviderTurn";
	readonly turnId: string;
	readonly providerInputJson: string;
};

export type ProviderInterruptCommand = {
	readonly _tag: "InterruptProviderTurn";
	readonly turnId: string;
	readonly requestedAt: number;
};

export type ScheduledSuccessorCommand = {
	readonly _tag: "StartScheduledSuccessor";
	readonly turnId: string;
	readonly queueId: string;
	readonly inputJson: string;
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

export const providerTurnReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	ProviderTurnCommand
> = {
	name: "provider-turn",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "ProviderTurnRequested"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "SendProviderTurn",
								turnId: record.event.turnId,
								providerInputJson: record.event.providerInputJson,
							},
						},
					]
				: [],
		),
};

export const providerInterruptReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	ProviderInterruptCommand
> = {
	name: "provider-interrupt",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "TurnInterruptRequested"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "InterruptProviderTurn",
								turnId: record.event.turnId,
								requestedAt: record.event.requestedAt,
							},
						},
					]
				: [],
		),
};

export const scheduledSuccessorReactorDefinition: ReactorDefinition<
	StoredEvent<SessionEvent>,
	ScheduledSuccessorCommand
> = {
	name: "scheduled-successor",
	react: (record) =>
		Effect.succeed(
			record.event._tag === "ScheduledSuccessorReady"
				? [
						{
							streamId: record.streamId,
							command: {
								_tag: "StartScheduledSuccessor",
								turnId: record.event.turnId,
								queueId: record.event.queueId,
								inputJson: record.event.inputJson,
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
