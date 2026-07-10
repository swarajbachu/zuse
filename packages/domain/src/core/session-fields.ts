import {
	PermissionMode,
	ResumeStrategy,
	RuntimeMode,
	SessionStatus,
} from "@zuse/contracts";
import { Schema } from "effect";

export const SessionIdentityFields = {
	sessionId: Schema.String,
	chatId: Schema.String,
	projectId: Schema.String,
	createdAt: Schema.Number,
} as const;

export const SessionConfigurationFields = {
	title: Schema.String,
	providerId: Schema.String,
	model: Schema.String,
	status: SessionStatus,
	cursor: Schema.NullOr(Schema.String),
	resumeStrategy: ResumeStrategy,
	runtimeMode: RuntimeMode,
	agentsJson: Schema.NullOr(Schema.String),
	worktreeId: Schema.NullOr(Schema.String),
	forkedFromSessionId: Schema.NullOr(Schema.String),
	forkedFromMessageId: Schema.NullOr(Schema.String),
	permissionMode: PermissionMode,
	toolSearch: Schema.Boolean,
} as const;

export const SessionCreatedFields = {
	...SessionIdentityFields,
	...SessionConfigurationFields,
} as const;

export const CompleteSessionCreatedEvent = Schema.TaggedStruct(
	"SessionCreated",
	SessionCreatedFields,
);

export const SessionCreatedEventFields = {
	...SessionIdentityFields,
	title: Schema.optionalKey(SessionConfigurationFields.title),
	providerId: Schema.optionalKey(SessionConfigurationFields.providerId),
	model: Schema.optionalKey(SessionConfigurationFields.model),
	status: Schema.optionalKey(SessionConfigurationFields.status),
	cursor: Schema.optionalKey(SessionConfigurationFields.cursor),
	resumeStrategy: Schema.optionalKey(SessionConfigurationFields.resumeStrategy),
	runtimeMode: Schema.optionalKey(SessionConfigurationFields.runtimeMode),
	agentsJson: Schema.optionalKey(SessionConfigurationFields.agentsJson),
	worktreeId: Schema.optionalKey(SessionConfigurationFields.worktreeId),
	forkedFromSessionId: Schema.optionalKey(
		SessionConfigurationFields.forkedFromSessionId,
	),
	forkedFromMessageId: Schema.optionalKey(
		SessionConfigurationFields.forkedFromMessageId,
	),
	permissionMode: Schema.optionalKey(SessionConfigurationFields.permissionMode),
	toolSearch: Schema.optionalKey(SessionConfigurationFields.toolSearch),
} as const;
