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
	readonly createCalls: Ref.Ref<number>;
	readonly startProcessCalls: Ref.Ref<ReadonlyArray<string>>;
	readonly failNextCreateAfterProvision: Ref.Ref<boolean>;
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
			createCalls: yield* Ref.make(0),
			startProcessCalls: yield* Ref.make<ReadonlyArray<string>>([]),
			failNextCreateAfterProvision: yield* Ref.make(false),
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
			}) {
				yield* Ref.update(control.createCalls, (count) => count + 1);
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
					endpointDomain: "sandbox.test",
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
				create,
				fork: (input) =>
					create({
						sandboxId: input.sandboxId,
						providerLabel: input.providerLabel,
						network: { kind: "quarantined" },
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
				inspect: (providerSandboxId) =>
					Ref.get(control.sandboxes).pipe(
						Effect.map((items) => items.get(providerSandboxId) ?? null),
					),
				pause: (providerSandboxId) => setState(providerSandboxId, "paused"),
				resume: (providerSandboxId) =>
					setState(providerSandboxId, "running").pipe(
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
					Ref.get(control.sandboxes).pipe(
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
					registrations: [{ adapter }, ...registrations],
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
