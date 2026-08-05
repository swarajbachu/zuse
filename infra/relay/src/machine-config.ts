import { Context } from "effect";

export interface MachineControlConfig {
	readonly allowlistedAccountIds: ReadonlySet<string>;
	readonly manualEntitlementsEnabled: boolean;
	readonly liveCheckoutEnabled: boolean;
	readonly enrollmentTtlMs: number;
	readonly recoveryWindowMs: number;
	readonly finalSnapshotRetentionMs: number;
	readonly reconcileLeaseMs: number;
}

export const MachineControlConfiguration =
	Context.Reference<MachineControlConfig>(
		"@zuse/relay/MachineControlConfiguration",
		{
			defaultValue: () => ({
				allowlistedAccountIds: new Set(),
				manualEntitlementsEnabled: false,
				liveCheckoutEnabled: false,
				enrollmentTtlMs: 30 * 60 * 1_000,
				recoveryWindowMs: 7 * 24 * 60 * 60 * 1_000,
				finalSnapshotRetentionMs: 14 * 24 * 60 * 60 * 1_000,
				reconcileLeaseMs: 5 * 60 * 1_000,
			}),
		},
	);
