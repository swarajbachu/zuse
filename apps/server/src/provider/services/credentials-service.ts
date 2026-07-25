import type { ProviderId } from "@zuse/contracts";
import { Context, type Effect } from "effect";

import type { CredentialsError } from "../errors.ts";

/**
 * Encrypted-vault credential store keyed by `providerId`. The vault is
 * protected by one cached OS-keychain master key; individual credentials never
 * become Keychain entries. Used by SDK adapters without surfacing keys to the
 * renderer.
 * Set via the `agent.setCredential` RPC; never returned over the wire — only
 * `listConfigured()` is renderer-visible, surfaced as the `hasApiKey` flag
 * on `AgentAvailability`. CLI-login credentials (the primary auth path)
 * never touch this service.
 */
export interface CredentialsServiceShape {
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
