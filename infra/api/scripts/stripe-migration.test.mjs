import assert from "node:assert/strict";
import test from "node:test";
import {
	migrationScheduleParams,
	validateMigrationManifest,
} from "./stripe-migration.mjs";

const item = {
	accountId: "account",
	polarSubscriptionId: "polar_sub",
	stripeCustomerId: "cus_1",
	offerId: "cloud-workspace-standard-v1",
	renewalAtMs: 2000000,
};
test("preserves renewal anchor and prices without immediate billing or proration", () => {
	const params = migrationScheduleParams(item, "price_base", "price_overage");
	assert.equal(params.start_date, 2000);
	assert.equal(params.customer, "cus_1");
	assert.deepEqual(params.phases[0].items, [
		{ price: "price_base", quantity: 1 },
		{ price: "price_overage" },
	]);
	assert.equal(params.phases[0].proration_behavior, "none");
	assert.equal(params.default_settings.automatic_tax.enabled, true);
});
test("rejects duplicate, past, unsupported and ambiguous migration entries", () => {
	assert.deepEqual(validateMigrationManifest([item], 1000000), [item]);
	assert.throws(
		() => validateMigrationManifest([item, item], 1000000),
		/Duplicate/,
	);
	assert.throws(
		() =>
			validateMigrationManifest([{ ...item, renewalAtMs: 1000000 }], 1000000),
		/Invalid/,
	);
	assert.throws(
		() => validateMigrationManifest([{ ...item, offerId: "other" }], 1000000),
		/Invalid/,
	);
	assert.throws(
		() =>
			validateMigrationManifest([{ ...item, renewalAtMs: 2000001 }], 1000000),
		/Invalid/,
	);
	assert.throws(
		() => migrationScheduleParams(item, "same", "same"),
		/distinct/,
	);
});
