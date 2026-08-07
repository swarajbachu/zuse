import { WIRE_PROTOCOL_VERSION } from "@zuse/contracts";
import {
	type MachineProviderAdapter,
	MachineProviders,
} from "@zuse/machine-providers";
import {
	HETZNER_LEGACY_PROVIDER_ID,
	HETZNER_PROVIDER_ID,
} from "@zuse/machine-providers/hetzner";
import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
	HetznerMachineProviderModule,
	MachineProviderConfigurationError,
	type MachineProviderModule,
	renderMachineCloudInit,
	resolveMachineProviderRuntime,
} from "../../src/machine-provider-config.ts";

const template = [
	"machine=__MACHINE_ID__",
	"label=__MACHINE_LABEL__",
	"relay=__RELAY_URL__",
	"issuer=__RELAY_ISSUER__",
	"token=__ENROLLMENT_TOKEN__",
	"manifest=__RUNTIME_MANIFEST_URL__",
	"wire=__WIRE_PROTOCOL_VERSION__",
	"key=__RUNTIME_SIGNING_PUBLIC_JWK__",
	"installer:",
	"      __RUNTIME_INSTALLER_SOURCE__",
].join("\n");

const bootstrap = {
	cloudInitTemplate: template,
	relayIssuer: "https://relay.test",
	runtimeInstallerSource: 'console.log("install");\n',
} as const;

const completeEnvironment = {
	MACHINE_PROVIDER: "hetzner",
	HETZNER_API_TOKEN: "secret",
	HETZNER_API_BASE_URL: "https://cloud.test/v1",
	HETZNER_FIREWALL_ID: "42",
	HETZNER_IMAGE: "ubuntu-current",
	HETZNER_LOCATION: "eu-1",
	HETZNER_SERVER_TYPE_PERSISTENT_STANDARD_V1: "standard-4-8",
	MACHINE_RUNTIME_MANIFEST_URL: "https://releases.test/stable.json",
	MACHINE_RUNTIME_SIGNING_PUBLIC_JWK: '{"kty":"OKP"}',
} as const;

const providerAdapter = (providerId: string): MachineProviderAdapter => ({
	providerId,
	create: () => Effect.die("unused"),
	recoverByLabel: () => Effect.succeed(null),
	inspect: () => Effect.succeed(null),
	powerOff: () => Effect.void,
	powerOn: () => Effect.void,
	snapshot: () => Effect.die("unused"),
	delete: () => Effect.void,
	deleteSnapshot: () => Effect.void,
});

const providerModule = (
	providerId: string,
	options: {
		readonly configured?: boolean;
		readonly aliases?: ReadonlyArray<string>;
	} = {},
): MachineProviderModule => ({
	providerId,
	productionReady: true,
	configure: () =>
		options.configured === false
			? undefined
			: {
					adapter: providerAdapter(providerId),
					aliases: options.aliases,
				},
});

describe("machine provider configuration", () => {
	test("defaults to the fake provider with production checkout disabled", () => {
		const runtime = resolveMachineProviderRuntime({}, bootstrap);

		expect(runtime.providerId).toBe("fake");
		expect(runtime.productionReady).toBe(false);
	});

	test("does not activate an unselected adapter from a staged token alone", () => {
		const runtime = resolveMachineProviderRuntime(
			{
				MACHINE_PROVIDER: "fake",
				HETZNER_API_TOKEN: "secret",
			},
			bootstrap,
		);

		expect(runtime.providerId).toBe("fake");
		expect(runtime.productionReady).toBe(false);
	});

	test("fails closed when an explicitly enabled adapter is incomplete", () => {
		expect(() =>
			resolveMachineProviderRuntime(
				{
					MACHINE_PROVIDER: "fake",
					HETZNER_ADAPTER_ENABLED: "true",
					HETZNER_API_TOKEN: "secret",
				},
				bootstrap,
			),
		).toThrow(MachineProviderConfigurationError);
	});

	test("fails closed when live provider configuration is incomplete", () => {
		expect(() =>
			resolveMachineProviderRuntime({ MACHINE_PROVIDER: "hetzner" }, bootstrap),
		).toThrow(MachineProviderConfigurationError);
	});

	test("rejects placeholder values in live provider configuration", () => {
		expect(() =>
			resolveMachineProviderRuntime(
				{
					...completeEnvironment,
					HETZNER_API_TOKEN: "REPLACE_WITH_SECRET",
				},
				bootstrap,
			),
		).toThrow(MachineProviderConfigurationError);
	});

	test("accepts only a complete HTTPS live provider configuration", () => {
		const runtime = resolveMachineProviderRuntime(
			completeEnvironment,
			bootstrap,
		);

		expect(runtime.providerId).toBe(HETZNER_PROVIDER_ID);
		expect(runtime.productionReady).toBe(true);
	});

	test("keeps machines with the previous provider id reconcilable", async () => {
		const runtime = resolveMachineProviderRuntime(
			completeEnvironment,
			bootstrap,
		);

		const providerIds = await Effect.runPromise(
			Effect.gen(function* () {
				const providers = yield* MachineProviders;
				return {
					current: (yield* providers.getDefault).providerId,
					legacy: (yield* providers.get(HETZNER_LEGACY_PROVIDER_ID)).providerId,
				};
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(providerIds).toEqual({
			current: HETZNER_PROVIDER_ID,
			legacy: HETZNER_LEGACY_PROVIDER_ID,
		});
	});

	test("loads every configured module while selecting one default", async () => {
		const runtime = resolveMachineProviderRuntime(
			{ MACHINE_PROVIDER: "provider-b" },
			bootstrap,
			[
				providerModule("provider-a", { aliases: ["provider-a-legacy"] }),
				providerModule("provider-b"),
				providerModule("provider-c", { configured: false }),
			],
		);

		const providers = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* MachineProviders;
				return {
					defaultProvider: (yield* registry.getDefault).providerId,
					providerIds: registry.providerIds,
				};
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.providerId).toBe("provider-b");
		expect(runtime.productionReady).toBe(true);
		expect(providers).toEqual({
			defaultProvider: "provider-b",
			providerIds: ["provider-a", "provider-a-legacy", "provider-b"],
		});
	});

	test("keeps configured live modules available when fake is the default", async () => {
		const runtime = resolveMachineProviderRuntime(
			{ MACHINE_PROVIDER: "fake" },
			bootstrap,
			[providerModule("provider-a", { aliases: ["provider-a-legacy"] })],
		);

		const providers = await Effect.runPromise(
			Effect.gen(function* () {
				const registry = yield* MachineProviders;
				return {
					defaultProvider: (yield* registry.getDefault).providerId,
					currentProvider: (yield* registry.get("provider-a")).providerId,
					legacyProvider: (yield* registry.get("provider-a-legacy")).providerId,
				};
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(runtime.productionReady).toBe(false);
		expect(providers).toEqual({
			defaultProvider: "fake",
			currentProvider: "provider-a",
			legacyProvider: "provider-a-legacy",
		});
	});

	test("does not activate an unselected module from its optional API URL", async () => {
		const runtime = resolveMachineProviderRuntime(
			{
				MACHINE_PROVIDER: "provider-b",
				HETZNER_API_BASE_URL: "https://api.hetzner.cloud/v1",
			},
			bootstrap,
			[HetznerMachineProviderModule, providerModule("provider-b")],
		);

		const providerIds = await Effect.runPromise(
			Effect.gen(function* () {
				const providers = yield* MachineProviders;
				return providers.providerIds;
			}).pipe(Effect.provide(runtime.layer)),
		);

		expect(providerIds).toEqual(["provider-b"]);
	});

	test("renders every bootstrap placeholder and escapes the shell command", () => {
		const rendered = renderMachineCloudInit(template, {
			machineId: "machine_1",
			providerLabel: "zuse-machine-1",
			enrollmentToken: "zenr_secret",
			relayUrl: "https://relay.test",
			relayIssuer: "https://relay.test",
			runtimeManifestUrl: "https://releases.test/stable.json",
			runtimeSigningPublicJwk: '{"kty":"OKP"}',
			runtimeInstallerSource: 'console.log("install");\n',
		});

		expect(rendered).not.toMatch(/__[A-Z0-9_]+__/);
		expect(rendered).toContain('      console.log("install");');
		expect(rendered).toContain("token=zenr_secret");
		expect(rendered).toContain(`wire=${WIRE_PROTOCOL_VERSION}`);
	});
});
