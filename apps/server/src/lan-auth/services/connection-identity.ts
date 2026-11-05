import type {
	AuthTokenId,
	ChatAccessPermission,
	ChatId,
	FolderId,
	RpcAccessDeniedError,
} from "@zuse/contracts";
import { Context, Effect, Option } from "effect";

/** Runtime-local gateway credential; authority is revalidated, never supplied by RPC headers. */
export interface WorkspaceCredentialIdentity {
	readonly kind: "workspace";
	readonly subject: string;
	readonly membershipId: string;
	readonly workspaceId: string;
	readonly chatId: ChatId;
	readonly projectId: FolderId;
	readonly expiresAt: number;
	readonly authorize: Effect.Effect<ChatAccessPermission, RpcAccessDeniedError>;
	/** Fresh control-plane owner/administrator check, installed by trusted transport. */
	readonly authorizeAutomations?: Effect.Effect<void, RpcAccessDeniedError>;
}

/** Verified credential identity, not a workspace permission or client-supplied actor. */
export type CredentialIdentity =
	| WorkspaceCredentialIdentity
	| {
			readonly kind: "paired";
			readonly tokenId: AuthTokenId;
			readonly deviceId: string | null;
	  }
	| {
			readonly kind: "account";
			readonly subject: string;
			readonly expiresAt: number;
	  };

/** Installed by the transport, never decoded from RPC metadata. */
export class ConnectionIdentity extends Context.Service<
	ConnectionIdentity,
	CredentialIdentity | { readonly kind: "local" }
>()("zuse/lan-auth/ConnectionIdentity") {}

export const connectionWorkspaceActor = Effect.map(
	Effect.serviceOption(ConnectionIdentity),
	(identity) =>
		Option.isSome(identity) && identity.value.kind === "workspace"
			? {
					subject: identity.value.subject,
					membershipId: identity.value.membershipId,
				}
			: undefined,
);
