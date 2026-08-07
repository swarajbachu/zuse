import type { ProviderId } from "@zuse/contracts";
import { Context, type Effect, Schema } from "effect";

import type { CredentialsError } from "../errors.ts";

export const ProviderCredentialKind = Schema.Literals([
	"api-key",
	"oauth-token",
]);
export type ProviderCredentialKind = typeof ProviderCredentialKind.Type;

export class ProviderCredential extends Schema.Class<ProviderCredential>(
	"ProviderCredential",
)({
	kind: ProviderCredentialKind,
	secret: Schema.String,
	updatedAt: Schema.Number,
}) {}

export interface ProviderCredentialInput {
	readonly kind: ProviderCredentialKind;
	readonly secret: string;
}

/**
 * Encrypted-vault credential store keyed by `providerId`. The vault is
 * protected by one cached OS-keychain master key; individual credentials never
 * become Keychain entries. Used by SDK adapters without surfacing keys to the
 * renderer.
 * API keys are set via `agent.setCredential`; the cloud account-access flow can
 * store a sealed Claude OAuth token through the server-side typed methods.
 * Secrets are never returned over the wire — only `listConfigured()` is
 * renderer-visible, surfaced as `hasApiKey` on `AgentAvailability`. Native CLI
 * login stores for GitHub and Codex remain outside this service.
 */
export interface CredentialsServiceShape {
	readonly getProviderCredential: (
		providerId: ProviderId,
	) => Effect.Effect<ProviderCredential | null, CredentialsError>;
	readonly setProviderCredential: (
		providerId: ProviderId,
		credential: ProviderCredentialInput,
	) => Effect.Effect<void, CredentialsError>;
	readonly get: (
		providerId: ProviderId,
	) => Effect.Effect<string | null, CredentialsError>;
	readonly set: (
		providerId: ProviderId,
		apiKey: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly remove: (
		providerId: ProviderId,
	) => Effect.Effect<void, CredentialsError>;
	readonly listConfigured: () => Effect.Effect<
		ReadonlyArray<ProviderId>,
		CredentialsError
	>;

	/**
	 * In-app agent browser credentials — DUMMY/TEST logins only. Keyed by web
	 * origin in the encrypted vault. Stored as
	 * `{ username, password }`. `listBrowser` deliberately drops the password so
	 * the settings UI only ever sees origin + username.
	 */
	readonly setBrowser: (
		origin: string,
		username: string,
		password: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly getBrowser: (
		origin: string,
	) => Effect.Effect<
		{ username: string; password: string } | null,
		CredentialsError
	>;
	readonly removeBrowser: (
		origin: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly listBrowser: () => Effect.Effect<
		ReadonlyArray<{ origin: string; username: string }>,
		CredentialsError
	>;

	/**
	 * Legacy compatibility methods. WorkOS sessions now live in SessionStore;
	 * the live implementation deliberately does not inspect old Keychain items.
	 */
	readonly getWorkosSession: () => Effect.Effect<
		string | null,
		CredentialsError
	>;
	readonly setWorkosSession: (
		bundleJson: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly removeWorkosSession: () => Effect.Effect<void, CredentialsError>;

	/** Secret JSON bundles for native third-party integrations. */
	readonly getIntegration: (
		integration: string,
		accountId: string,
	) => Effect.Effect<string | null, CredentialsError>;
	readonly setIntegration: (
		integration: string,
		accountId: string,
		value: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly removeIntegration: (
		integration: string,
		accountId: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly listIntegrationAccounts: (
		integration: string,
	) => Effect.Effect<ReadonlyArray<string>, CredentialsError>;

	/**
	 * OAuth token bundle for a user MCP server (claude-source servers Zuse
	 * authenticates itself — codex-source tokens live in Codex's own store).
	 * Keyed by the server's descriptor key (`claude:<name>`), namespaced
	 * `mcpOAuth:<key>`, stored as the JSON the MCP SDK's OAuthClientProvider
	 * round-trips (tokens + client registration). Never crosses the wire.
	 */
	readonly getMcpOauth: (
		serverKey: string,
	) => Effect.Effect<string | null, CredentialsError>;
	readonly setMcpOauth: (
		serverKey: string,
		bundleJson: string,
	) => Effect.Effect<void, CredentialsError>;
	readonly removeMcpOauth: (
		serverKey: string,
	) => Effect.Effect<void, CredentialsError>;
}

export class CredentialsService extends Context.Service<
	CredentialsService,
	CredentialsServiceShape
>()("memoize/CredentialsService") {}
