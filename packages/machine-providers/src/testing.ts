import { Context, Effect, Layer, Ref } from "effect";
import {
	type MachineProviderAdapter,
	MachineProviderError,
	type MachineProviderRegistration,
	MachineProviders,
	makeMachineProviders,
	type ProviderMachine,
} from "./index.ts";

export interface FakeMachineProviderControl {
	readonly servers: Ref.Ref<Map<string, ProviderMachine>>;
	readonly snapshots: Ref.Ref<Set<string>>;
	readonly createCalls: Ref.Ref<number>;
	readonly failNextCreateAfterProvision: Ref.Ref<boolean>;
}

export class FakeMachineProviderControlService extends Context.Service<
	FakeMachineProviderControlService,
	FakeMachineProviderControl
>()("@zuse/machine-providers/testing/FakeMachineProviderControl") {}

const FakeMachineProviderControlLive = Layer.effect(
	FakeMachineProviderControlService,
	Effect.gen(function* () {
		return FakeMachineProviderControlService.of({
			servers: yield* Ref.make(new Map<string, ProviderMachine>()),
			snapshots: yield* Ref.make(new Set<string>()),
			createCalls: yield* Ref.make(0),
			failNextCreateAfterProvision: yield* Ref.make(false),
		});
	}),
);

const makeMachineProvidersFakeFromControl = (
	registrations: ReadonlyArray<MachineProviderRegistration>,
) =>
	Layer.effect(
		MachineProviders,
		Effect.gen(function* () {
			const control = yield* FakeMachineProviderControlService;
			const adapter: MachineProviderAdapter = {
				providerId: "fake",
				create: Effect.fn("FakeMachineProvider.create")(function* (input) {
					yield* Ref.update(control.createCalls, (count) => count + 1);
					const existing = yield* Ref.get(control.servers).pipe(
						Effect.map(
							(items) =>
								[...items.values()].find(
									(item) => item.providerLabel === input.providerLabel,
								) ?? null,
						),
					);
					if (existing !== null) return existing;
					const created: ProviderMachine = {
						providerServerId: `fake-${input.machineId}`,
						providerLabel: input.providerLabel,
						powerState: "running",
					};
					yield* Ref.update(control.servers, (items) =>
						new Map(items).set(created.providerServerId, created),
					);
					if (
						yield* Ref.getAndSet(control.failNextCreateAfterProvision, false)
					) {
						return yield* new MachineProviderError({ code: "transient" });
					}
					return created;
				}),
				recoverByLabel: (providerLabel) =>
					Ref.get(control.servers).pipe(
						Effect.map(
							(items) =>
								[...items.values()].find(
									(item) => item.providerLabel === providerLabel,
								) ?? null,
						),
					),
				inspect: (providerServerId) =>
					Ref.get(control.servers).pipe(
						Effect.map((items) => items.get(providerServerId) ?? null),
					),
				powerOff: (providerServerId) =>
					Ref.update(control.servers, (items) => {
						const found = items.get(providerServerId);
						return found === undefined
							? items
							: new Map(items).set(providerServerId, {
									...found,
									powerState: "off",
								});
					}),
				powerOn: (providerServerId) =>
					Ref.update(control.servers, (items) => {
						const found = items.get(providerServerId);
						return found === undefined
							? items
							: new Map(items).set(providerServerId, {
									...found,
									powerState: "running",
								});
					}),
				snapshot: (providerServerId, label) =>
					Ref.get(control.servers).pipe(
						Effect.flatMap((items) =>
							items.has(providerServerId)
								? Effect.succeed(`fake-snapshot-${label}`)
								: new MachineProviderError({ code: "not-found" }),
						),
						Effect.tap((snapshotId) =>
							Ref.update(control.snapshots, (items) =>
								new Set(items).add(snapshotId),
							),
						),
					),
				delete: (providerServerId) =>
					Ref.update(control.servers, (items) => {
						const next = new Map(items);
						next.delete(providerServerId);
						return next;
					}),
				deleteSnapshot: (snapshotId) =>
					Ref.update(control.snapshots, (items) => {
						const next = new Set(items);
						next.delete(snapshotId);
						return next;
					}),
			};
			return MachineProviders.of(
				yield* makeMachineProviders({
					registrations: [{ adapter }, ...registrations],
					defaultProviderId: adapter.providerId,
				}),
			);
		}),
	);

export const makeMachineProvidersFake = (
	registrations: ReadonlyArray<MachineProviderRegistration> = [],
) =>
	makeMachineProvidersFakeFromControl(registrations).pipe(
		Layer.provideMerge(FakeMachineProviderControlLive),
		Layer.orDie,
	);

export const MachineProvidersFake = makeMachineProvidersFake();
