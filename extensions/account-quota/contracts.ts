import { defineRpc } from "@zuse/extension-sdk";
import { Schema } from "effect";
export const Account = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	provider: Schema.Literals(["codex", "claude"]),
	credentialPath: Schema.String,
	usesCurrentLogin: Schema.optional(Schema.Boolean),
});
export type AccountProfile = typeof Account.Type;
export const Window = Schema.Struct({
	id: Schema.String,
	label: Schema.String,
	usedPercent: Schema.NullOr(Schema.Number),
	resetsAt: Schema.NullOr(Schema.String),
});
export const Result = Schema.Struct({
	account: Account,
	windows: Schema.Array(Window),
	fetchedAt: Schema.NullOr(Schema.String),
	error: Schema.NullOr(Schema.String),
	plan: Schema.NullOr(Schema.String),
});
export type QuotaResult = typeof Result.Type;
export const quotaRpc = defineRpc({
	name: "accounts",
	input: Schema.Struct({
		action: Schema.Literals(["list", "add", "connect", "remove", "refresh"]),
		id: Schema.String,
		label: Schema.String,
		provider: Schema.Literals(["codex", "claude"]),
		credentialPath: Schema.String,
	}),
	output: Schema.Array(Result),
});
