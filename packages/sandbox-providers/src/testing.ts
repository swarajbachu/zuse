import { Context, Effect, Layer, Ref } from "effect";
import {
	makeSandboxProviders,
	type ProviderSandbox,
	type SandboxNetworkPolicy,
	type SandboxProviderAdapter,
	SandboxProviderError,
	type SandboxProviderRegistration,
	SandboxProviders,
} from "./index.ts";

export interface FakeSandboxProviderControl {
	readonly sandboxes: Ref.Ref<Map<string, ProviderSandbox>>;
	readonly networkBySandbox: Ref.Ref<Map<string, SandboxNetworkPolicy>>;
	readonly snapshots: Ref.Ref<Set<string>>;
	readonly pathsBySandbox: Ref.Ref<Map<string, Set<string>>>;
	readonly createCalls: Ref.Ref<number>;
	readonly createInputs: Ref.Ref<
		ReadonlyArray<{
			readonly timeoutSeconds: number;
			readonly onTimeout: "pause" | "terminate";
		}>
	>;
	readonly resumeInputs: Ref.Ref<
		ReadonlyArray<{
			readonly timeoutSeconds: number;
			readonly onTimeout: "pause" | "terminate";
		}>
	>;
	readonly startProcessCalls: Ref.Ref<ReadonlyArray<string>>;
	readonly failNextCreateAfterProvision: Ref.Ref<boolean>;
	readonly failNextSnapshot: Ref.Ref<boolean>;
}

export class FakeSandboxProviderControlService extends Context.Service<
	FakeSandboxProviderControlService,
	FakeSandboxProviderControl
>()("@zuse/sandbox-providers/testing/FakeSandboxProviderControl") {}

const FakeSandboxProviderControlLive = Layer.effect(
	FakeSandboxProviderControlService,
	Effect.gen(function* () {
		return FakeSandboxProviderControlService.of({
			sandboxes: yield* Ref.make(new Map<string, ProviderSandbox>()),
			networkBySandbox: yield* Ref.make(
				new Map<string, SandboxNetworkPolicy>(),
			),
			snapshots: yield* Ref.make(new Set<string>()),
			pathsBySandbox: yield* Ref.make(new Map<string, Set<string>>()),
			createCalls: yield* Ref.make(0),
			createInputs: yield* Ref.make<
				ReadonlyArray<{
					readonly timeoutSeconds: number;
					readonly onTimeout: "pause" | "terminate";
				}>
			>([]),
			resumeInputs: yield* Ref.make<
				ReadonlyArray<{
					readonly timeoutSeconds: number;
					readonly onTimeout: "pause" | "terminate";
				}>
			>([]),
			startProcessCalls: yield* Ref.make<ReadonlyArray<string>>([]),
			failNextCreateAfterProvision: yield* Ref.make(false),
			failNextSnapshot: yield* Ref.make(false),
		});
	}),
);

const makeSandboxProvidersFakeFromControl = (
	registrations: ReadonlyArray<SandboxProviderRegistration>,
) =>
	Layer.effect(
		SandboxProviders,
		Effect.gen(function* () {
			const control = yield* FakeSandboxProviderControlService;
			const create = Effect.fn("FakeSandboxProvider.create")(function* (input: {
				readonly sandboxId: string;
				readonly providerLabel: string;
				readonly network: SandboxNetworkPolicy;
				readonly timeoutSeconds: number;
				readonly onTimeout: "pause" | "terminate";
			}) {
				yield* Ref.update(control.createCalls, (count) => count + 1);
				yield* Ref.update(control.createInputs, (calls) => [
					...calls,
					{
						timeoutSeconds: input.timeoutSeconds,
						onTimeout: input.onTimeout,
					},
				]);
				const existing = yield* Ref.get(control.sandboxes).pipe(
					Effect.map(
						(items) =>
							[...items.values()].find(
								(item) => item.providerLabel === input.providerLabel,
							) ?? null,
					),
				);
				if (existing !== null) return existing;
				const created: ProviderSandbox = {
					providerSandboxId: `fake-${input.sandboxId}`,
					providerLabel: input.providerLabel,
					state: "running",
				};
				yield* Ref.update(control.sandboxes, (items) =>
					new Map(items).set(created.providerSandboxId, created),
				);
				yield* Ref.update(control.networkBySandbox, (items) =>
					new Map(items).set(created.providerSandboxId, input.network),
				);
				if (yield* Ref.getAndSet(control.failNextCreateAfterProvision, false)) {
					return yield* new SandboxProviderError({ code: "transient" });
				}
				return created;
			});
			const setState = (
				providerSandboxId: string,
				state: ProviderSandbox["state"],
			) =>
				Ref.update(control.sandboxes, (items) => {
					const found = items.get(providerSandboxId);
					return found === undefined
						? items
						: new Map(items).set(providerSandboxId, { ...found, state });
				});
			const adapter: SandboxProviderAdapter = {
				providerId: "fake",
				displayName: "Test sandbox",
				templateVersion: "test-template",
				create,
				fork: (input) =>
					create({
						sandboxId: input.sandboxId,
						providerLabel: input.providerLabel,
						network: input.network,
						timeoutSeconds: input.timeoutSeconds,
						onTimeout: input.onTimeout,
					}),
				recoverByLabel: (providerLabel) =>
					Ref.get(control.sandboxes).pipe(
						Effect.map(
							(items) =>
								[...items.values()].find(
									(item) => item.providerLabel === providerLabel,
								) ?? null,
						),
					),
				startProcess: (providerSandboxId) =>
					Ref.update(control.startProcessCalls, (calls) => [
						...calls,
						providerSandboxId,
					]),
				replaceProcess: (providerSandboxId) =>
					Ref.update(control.startProcessCalls, (calls) => [
						...calls,
						providerSandboxId,
					]),
				pathExists: (providerSandboxId, path) =>
					Ref.get(control.pathsBySandbox).pipe(
						Effect.map(
							(items) => items.get(providerSandboxId)?.has(path) ?? false,
						),
					),
				readTextFile: () => Effect.succeed(""),
				writeTextFile: () => Effect.void,
				inspect: (providerSandboxId) =>
					Ref.get(control.sandboxes).pipe(
						Effect.map((items) => items.get(providerSandboxId) ?? null),
					),
				resolveEndpoint: (providerSandboxId, port) =>
					Effect.succeed({
						httpBaseUrl: `https://${port}-${providerSandboxId}.sandbox.test`,
						wsBaseUrl: `wss://${port}-${providerSandboxId}.sandbox.test`,
					}),
				pause: (providerSandboxId) => setState(providerSandboxId, "paused"),
				resume: (providerSandboxId, timeoutSeconds, onTimeout) =>
					Ref.update(control.resumeInputs, (calls) => [
						...calls,
						{ timeoutSeconds, onTimeout },
					]).pipe(
						Effect.andThen(setState(providerSandboxId, "running")),
						Effect.andThen(Ref.get(control.sandboxes)),
						Effect.flatMap((items) => {
							const found = items.get(providerSandboxId);
							return found === undefined
								? new SandboxProviderError({ code: "not-found" })
								: Effect.succeed(found);
						}),
					),
				extendTimeout: () => Effect.void,
				setNetwork: (providerSandboxId, network) =>
					Ref.update(control.networkBySandbox, (items) =>
						new Map(items).set(providerSandboxId, network),
					),
				snapshot: (providerSandboxId, name) =>
					Ref.getAndSet(control.failNextSnapshot, false).pipe(
						Effect.flatMap((fail) =>
							fail
								? Effect.fail(new SandboxProviderError({ code: "transient" }))
								: Ref.get(control.sandboxes),
						),
						Effect.flatMap((items) =>
							items.has(providerSandboxId)
								? Effect.succeed(`fake-snapshot-${name}`)
								: new SandboxProviderError({ code: "not-found" }),
						),
						Effect.tap((snapshotId) =>
							Ref.update(control.snapshots, (items) =>
								new Set(items).add(snapshotId),
							),
						),
					),
				kill: (providerSandboxId) =>
					Ref.update(control.sandboxes, (items) => {
						const next = new Map(items);
						next.delete(providerSandboxId);
						return next;
					}),
				deleteSnapshot: (snapshotId) =>
					Ref.update(control.snapshots, (items) => {
						const next = new Set(items);
						next.delete(snapshotId);
						return next;
					}),
			};
			return SandboxProviders.of(
				yield* makeSandboxProviders({
					registrations: [{ adapter, advertised: false }, ...registrations],
					defaultProviderId: adapter.providerId,
				}),
			);
		}),
	);

export const makeSandboxProvidersFake = (
	registrations: ReadonlyArray<SandboxProviderRegistration> = [],
) =>
	makeSandboxProvidersFakeFromControl(registrations).pipe(
		Layer.provideMerge(FakeSandboxProviderControlLive),
		Layer.orDie,
	);

export const SandboxProvidersFake = makeSandboxProvidersFake();
