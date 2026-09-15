import {
	makeProviderRegistry,
	type ProviderRegistry,
	type ProviderRegistryConfigError,
} from "@zuse/provider-registry";
import { Context, Effect, Layer, Schema } from "effect";

export class SandboxProviderError extends Schema.TaggedErrorClass<SandboxProviderError>()(
	"SandboxProviderError",
	{
		code: Schema.Literals(["transient", "not-found", "rejected"]),
	},
) {}

// Egress policy for a sandbox. A fork always starts "quarantined" (ADR 0033:
// the barrier must be provider-enforced, never a caller choice), and the
// post-enrollment open step must write the final intended policy in one call.
export type SandboxNetworkPolicy =
	| { readonly kind: "quarantined" }
	| { readonly kind: "open" }
	| {
			readonly kind: "restricted";
			readonly allowOut: ReadonlyArray<string>;
			readonly denyOut: ReadonlyArray<string>;
	  };

export interface ProviderSandbox {
	readonly providerSandboxId: string;
	readonly providerLabel: string;
	readonly state: "running" | "paused";
}

export interface SandboxProviderResources {
	readonly vcpuCount: number;
	readonly memoryMib: number;
}

export interface SandboxProviderSize extends SandboxProviderResources {
	readonly sizeId: string;
	readonly displayName: string;
}

/** Compute dimensions for a placement, falling back to the default profile. */
export const resolveSandboxResources = (
	adapter: Pick<SandboxProviderAdapter, "resources" | "sizes">,
	sizeId?: string,
): SandboxProviderResources =>
	adapter.sizes.find((size) => size.sizeId === sizeId) ?? adapter.resources;

export interface SandboxEndpoint {
	readonly httpBaseUrl: string;
	readonly wsBaseUrl: string;
}

export interface SandboxProcessInput {
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly user?: string;
	readonly tag?: string;
}

export interface SandboxProcessSelector {
	readonly tag: string;
	readonly legacyCommandMarkers?: ReadonlyArray<string>;
	readonly legacyCleanup?: "matching-command";
}

/** Provider-reported list-price usage for one exact time window. */
export interface ProviderSandboxUsage {
	readonly startedAtMs: number;
	readonly endedAtMs: number;
	/** Provider billing units; any size multiplier is already applied. */
	readonly billableSeconds: number;
	readonly providerCostMicros: number;
	readonly running: boolean;
	/** Current list-price rate per wall-clock second, for provisional reservations. */
	readonly costMicrosPerSecond: number;
}

export interface SandboxProviderAdapter {
	readonly providerId: string;
	readonly displayName: string;
	readonly getUsage?: (
		providerSandboxId: string,
		window: {
			readonly startedAtMs: number;
			readonly endedAtMs: number;
		},
	) => Effect.Effect<ProviderSandboxUsage, SandboxProviderError>;
	readonly templateVersion: string;
	readonly resources: SandboxProviderResources;
	/** Whether pause/resume preserves the runtime process. */
	readonly preservesProcessesOnResume: boolean;
	// The placement choices this provider advertises. Providers with one fixed
	// profile expose a single entry matching `resources`.
	readonly sizes: ReadonlyArray<SandboxProviderSize>;
	readonly create: (input: {
		readonly sandboxId: string;
		readonly providerLabel: string;
		readonly metadata?: Readonly<Record<string, string>>;
		readonly sizeId?: string;
		readonly timeoutSeconds: number;
		readonly env: Readonly<Record<string, string>>;
		readonly network: SandboxNetworkPolicy;
		readonly onTimeout: "pause" | "terminate";
	}) => Effect.Effect<ProviderSandbox, SandboxProviderError>;
	readonly fork: (input: {
		readonly sandboxId: string;
		readonly providerLabel: string;
		readonly metadata?: Readonly<Record<string, string>>;
		readonly sizeId?: string;
		readonly snapshotId: string;
		readonly timeoutSeconds: number;
		readonly env: Readonly<Record<string, string>>;
		readonly network: SandboxNetworkPolicy;
		readonly onTimeout: "pause" | "terminate";
	}) => Effect.Effect<ProviderSandbox, SandboxProviderError>;
	readonly recoverByLabel: (
		providerLabel: string,
	) => Effect.Effect<ProviderSandbox | null, SandboxProviderError>;
	readonly startProcess: (
		providerSandboxId: string,
		input: SandboxProcessInput,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly replaceProcess: (
		providerSandboxId: string,
		selector: SandboxProcessSelector,
		input: SandboxProcessInput,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly pathExists: (
		providerSandboxId: string,
		path: string,
		user?: string,
	) => Effect.Effect<boolean, SandboxProviderError>;
	readonly readTextFile: (
		providerSandboxId: string,
		path: string,
		user?: string,
	) => Effect.Effect<string, SandboxProviderError>;
	readonly writeTextFile: (
		providerSandboxId: string,
		path: string,
		contents: string,
		user?: string,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly inspect: (
		providerSandboxId: string,
	) => Effect.Effect<ProviderSandbox | null, SandboxProviderError>;
	readonly resolveEndpoint: (
		providerSandboxId: string,
		port: number,
	) => Effect.Effect<SandboxEndpoint, SandboxProviderError>;
	readonly pause: (
		providerSandboxId: string,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly resume: (
		providerSandboxId: string,
		timeoutSeconds: number,
		onTimeout: "pause" | "terminate",
		sizeId?: string,
	) => Effect.Effect<ProviderSandbox, SandboxProviderError>;
	readonly extendTimeout: (
		providerSandboxId: string,
		timeoutSeconds: number,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly setNetwork: (
		providerSandboxId: string,
		network: SandboxNetworkPolicy,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly snapshot: (
		providerSandboxId: string,
		name: string,
	) => Effect.Effect<string, SandboxProviderError>;
	readonly kill: (
		providerSandboxId: string,
	) => Effect.Effect<void, SandboxProviderError>;
	readonly deleteSnapshot: (
		snapshotId: string,
	) => Effect.Effect<void, SandboxProviderError>;
}

export interface SandboxProviderRegistration {
	readonly adapter: SandboxProviderAdapter;
	readonly aliases?: ReadonlyArray<string>;
	readonly advertised?: boolean;
}

export interface SandboxProvidersApi
	extends ProviderRegistry<SandboxProviderAdapter> {
	readonly availableProviders: ReadonlyArray<SandboxProviderAdapter>;
}

const adaptersFor = (
	registrations: ReadonlyArray<SandboxProviderRegistration>,
): ReadonlyArray<SandboxProviderAdapter> =>
	registrations.flatMap(({ adapter, aliases = [] }) => [
		adapter,
		...aliases.map((providerId) => ({ ...adapter, providerId })),
	]);

export const makeSandboxProviders = Effect.fn("makeSandboxProviders")(
	(input: {
		readonly registrations: ReadonlyArray<SandboxProviderRegistration>;
		readonly defaultProviderId: string;
	}): Effect.Effect<SandboxProvidersApi, ProviderRegistryConfigError> =>
		makeProviderRegistry({
			adapters: adaptersFor(input.registrations),
			defaultProviderId: input.defaultProviderId,
		}).pipe(
			Effect.map((registry) => ({
				...registry,
				availableProviders: input.registrations
					.filter((registration) => registration.advertised !== false)
					.map((registration) => registration.adapter),
			})),
		),
);

export class SandboxProviders extends Context.Service<
	SandboxProviders,
	SandboxProvidersApi
>()("@zuse/sandbox-providers/SandboxProviders") {
	static readonly layer = (input: {
		readonly registrations: ReadonlyArray<SandboxProviderRegistration>;
		readonly defaultProviderId: string;
	}): Layer.Layer<SandboxProviders, ProviderRegistryConfigError> =>
		Layer.effect(
			SandboxProviders,
			makeSandboxProviders(input).pipe(Effect.map(SandboxProviders.of)),
		);
}
