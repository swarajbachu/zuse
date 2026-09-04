import { HOSTED_APP_URL } from "@zuse/contracts";
import { Context, Layer, type Redacted } from "effect";

/**
 * API configuration, provided once at Worker start from the environment
 * bindings (see worker.ts). Kept as a service so tests can supply fakes.
 *
 * - `apiIssuer` — this api's canonical URL; goes into tokens/challenges as
 *   `iss`/`aud` and is echoed to clients.
 * - `workosJwksUrl` / `workosIssuer` — used to verify the WorkOS access tokens
 *   presented by signed-in clients (desktop + mobile).
 * - `mintPrivateKey` / `mintPublicKey` — Ed25519 keypair the api uses to sign
 *   short-lived DPoP-bound access tokens and connect tokens. The public key is
 *   handed to environments so they can verify api-minted tokens.
 * - `connectTokenTtlMs` / `accessTokenTtlMs` — lifetimes for minted tokens.
 * - `presenceStaleMs` — an environment with no heartbeat within this window is
 *   reported offline.
 * - `managedTunnel` — Cloudflare credentials for provisioning a per-environment
 *   named tunnel. Absent (all creds unset) → managed tunnels are disabled and
 *   the api falls back to the LAN endpoint the desktop advertises.
 */
export interface ManagedTunnelConfig {
	readonly cfApiToken: Redacted.Redacted<string>;
	readonly cfAccountId: string;
	readonly cfZoneId: string;
	/** Zone apex the tunnel hostnames live under, e.g. `stuff.md`. */
	readonly baseDomain: string;
	/** Prefix that namespaces tunnel/hostnames per deployment, e.g. `zenv`. */
	readonly namespace: string;
}

export interface ApiConfig {
	readonly apiIssuer: string;
	readonly workosJwksUrl: string;
	readonly workosIssuer: string;
	/** Server-side key used only for permanent identity deletion. */
	readonly workosApiKey?: Redacted.Redacted<string>;
	readonly mintPrivateKey: Redacted.Redacted<string>;
	readonly mintPublicKey: string;
	/** 32-byte base64url AES key for cloud launch intents and transcripts. */
	readonly cloudDataEncryptionKey?: Redacted.Redacted<string>;
	readonly githubApp?: {
		readonly appId: string;
		readonly slug: string;
		readonly privateKey: Redacted.Redacted<string>;
		readonly clientId?: string;
		readonly clientSecret?: Redacted.Redacted<string>;
		readonly webhookSecret?: Redacted.Redacted<string>;
	};
	readonly e2bWebhookSecret?: Redacted.Redacted<string>;
	readonly cloudBillingEnforcementEnabled: boolean;
	readonly cloudBillingExportEnabled: boolean;
	readonly cloudBillingCutoverAtMs?: number;
	readonly cloudBillingPolarMeterId?: string;
	readonly cloudCommandMailboxEnabled: boolean;
	/** Allows newly-created workspaces to opt into broker-v1 Codex auth. */
	readonly cloudCodexAuthBrokerEnrollmentEnabled: boolean;
	/** Must remain enabled while any broker-v1 workspace exists. */
	readonly cloudCodexAuthBrokerServingEnabled: boolean;
	/** Allows new workspaces to keep all reusable provider auth out of images. */
	readonly cloudProviderAuthBrokerEnrollmentEnabled: boolean;
	/** Must remain enabled while any provider-broker-v1 workspace exists. */
	readonly cloudProviderAuthBrokerServingEnabled: boolean;
	readonly cloudTranscriptObjects?: CloudTranscriptObjectStore;
	readonly challengeTtlMs: number;
	readonly connectTokenTtlMs: number;
	readonly accessTokenTtlMs: number;
	readonly presenceStaleMs: number;
	/** Inactivity window before an active cloud workspace is paused. */
	readonly cloudWorkspaceIdleTimeoutMs: number;
	readonly cloudRepositoryCacheMaxBytes: number;
	readonly maxEnvironmentsPerAccount: number | null;
	readonly allowedBrowserOrigins: ReadonlyArray<string>;
	readonly managedTunnel?: ManagedTunnelConfig;
}

export interface CloudTranscriptObjectStore {
	readonly put: (key: string, value: string) => Promise<"created" | "exists">;
	readonly get: (key: string) => Promise<string | null>;
	readonly deletePrefix: (prefix: string) => Promise<void>;
}

export class ApiConfiguration extends Context.Service<
	ApiConfiguration,
	ApiConfig
>()("@zuse/api/ApiConfiguration") {}

const DEFAULTS = {
	challengeTtlMs: 5 * 60 * 1000,
	connectTokenTtlMs: 60 * 1000,
	accessTokenTtlMs: 30 * 60 * 1000,
	presenceStaleMs: 90 * 1000,
	cloudWorkspaceIdleTimeoutMs: 10 * 60 * 1000,
	cloudRepositoryCacheMaxBytes: 8 * 1024 * 1024 * 1024,
	maxEnvironmentsPerAccount: 5 as number | null,
	allowedBrowserOrigins: [HOSTED_APP_URL] as ReadonlyArray<string>,
	cloudBillingEnforcementEnabled: false,
	cloudBillingExportEnabled: false,
	cloudCommandMailboxEnabled: false,
	cloudCodexAuthBrokerEnrollmentEnabled: false,
	cloudCodexAuthBrokerServingEnabled: false,
	cloudProviderAuthBrokerEnrollmentEnabled: false,
	cloudProviderAuthBrokerServingEnabled: false,
} as const;

export const layer = (
	config: Omit<ApiConfig, keyof typeof DEFAULTS> &
		Partial<Pick<ApiConfig, keyof typeof DEFAULTS>>,
): Layer.Layer<ApiConfiguration> =>
	Layer.succeed(ApiConfiguration, { ...DEFAULTS, ...config });
