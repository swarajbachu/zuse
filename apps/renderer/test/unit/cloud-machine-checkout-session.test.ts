import { describe, expect, it } from "vitest";

import {
	clearCloudMachineCheckoutSession,
	readCloudMachineCheckoutSession,
	writeCloudMachineCheckoutSession,
} from "../../src/lib/cloud-machine-checkout-session.ts";

const makeStorage = () => {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	};
};

describe("cloud machine checkout session", () => {
	it("restores only the same account and offer", () => {
		const storage = makeStorage();
		writeCloudMachineCheckoutSession(storage, {
			accountId: "account-1",
			nowMs: 1_000,
			offerId: "offer-1",
			url: "https://checkout.example/session",
		});

		expect(
			readCloudMachineCheckoutSession(storage, {
				accountId: "account-1",
				nowMs: 2_000,
				offerId: "offer-1",
			}),
		).toBe("https://checkout.example/session");
		expect(
			readCloudMachineCheckoutSession(storage, {
				accountId: "account-2",
				nowMs: 2_000,
				offerId: "offer-1",
			}),
		).toBeNull();
	});

	it("expires an abandoned checkout so a fresh one can start", () => {
		const storage = makeStorage();
		writeCloudMachineCheckoutSession(storage, {
			accountId: "account-1",
			nowMs: 1_000,
			offerId: "offer-1",
			url: "https://checkout.example/session",
		});

		expect(
			readCloudMachineCheckoutSession(storage, {
				accountId: "account-1",
				nowMs: 31 * 60_000,
				offerId: "offer-1",
			}),
		).toBeNull();
	});

	it("clears the session after provisioning begins", () => {
		const storage = makeStorage();
		writeCloudMachineCheckoutSession(storage, {
			accountId: "account-1",
			nowMs: 1_000,
			offerId: "offer-1",
			url: "https://checkout.example/session",
		});
		clearCloudMachineCheckoutSession(storage);

		expect(
			readCloudMachineCheckoutSession(storage, {
				accountId: "account-1",
				nowMs: 2_000,
				offerId: "offer-1",
			}),
		).toBeNull();
	});
});
