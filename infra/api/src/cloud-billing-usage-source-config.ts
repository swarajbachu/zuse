import type { BillingUsageSourceModule } from "./cloud-billing-usage-source.ts";
import { BoxBillingUsageSourceModule } from "./cloud-billing-usage-sources/box.ts";
import { E2bBillingUsageSourceModule } from "./cloud-billing-usage-sources/e2b.ts";

export type {
	BillingUsageRecovery,
	BillingUsageSourceModule,
} from "./cloud-billing-usage-source.ts";

export const billingUsageSourceModules: ReadonlyArray<BillingUsageSourceModule> =
	[E2bBillingUsageSourceModule, BoxBillingUsageSourceModule];

export const findBillingUsageSourceModule = (
	provider: string,
): BillingUsageSourceModule | undefined =>
	billingUsageSourceModules.find((module) => module.provider === provider);
