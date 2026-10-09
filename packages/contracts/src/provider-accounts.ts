import { Schema } from "effect";
import { Rpc } from "effect/unstable/rpc";

export const NativeAccountProvider = Schema.Literals(["claude", "codex"]);
export type NativeAccountProvider = typeof NativeAccountProvider.Type;
export const ProviderAccount = Schema.Struct({
	id: Schema.String,
	providerId: NativeAccountProvider,
	name: Schema.String,
	preferred: Schema.Boolean,
});
export type ProviderAccount = typeof ProviderAccount.Type;
export class ProviderAccountError extends Schema.TaggedErrorClass<ProviderAccountError>()(
	"ProviderAccountError",
	{ message: Schema.String },
) {}
export const ProviderAccountsListRpc = Rpc.make("provider.accounts.list", {
	payload: { providerId: NativeAccountProvider },
	success: Schema.Struct({
		available: Schema.Boolean,
		accounts: Schema.Array(ProviderAccount),
	}),
	error: ProviderAccountError,
});
export const ProviderAccountsSaveRpc = Rpc.make("provider.accounts.save", {
	payload: {
		providerId: NativeAccountProvider,
		id: Schema.optional(Schema.String),
		name: Schema.String,
	},
	success: ProviderAccount,
	error: ProviderAccountError,
});
export const ProviderAccountsPreferredRpc = Rpc.make(
	"provider.accounts.preferred",
	{
		payload: {
			providerId: NativeAccountProvider,
			id: Schema.NullOr(Schema.String),
		},
		success: Schema.Void,
		error: ProviderAccountError,
	},
);
export const ProviderAccountsRemoveRpc = Rpc.make("provider.accounts.remove", {
	payload: { providerId: NativeAccountProvider, id: Schema.String },
	success: Schema.Void,
	error: ProviderAccountError,
});
