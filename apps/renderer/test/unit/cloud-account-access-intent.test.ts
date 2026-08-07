import { describe, expect, it } from "vitest";

import {
	consumeCloudAccountAccessIntent,
	requestCloudAccountAccess,
	subscribeToCloudAccountAccessIntent,
} from "../../src/lib/cloud-account-access-intent.ts";

const makeStorage = (): Storage => {
	const values = new Map<string, string>();
	return {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};
};

describe("cloud account-access intent", () => {
	it("hands a provider setup request to the cloud settings surface once", () => {
		const storage = makeStorage();
		const target = new EventTarget();

		requestCloudAccountAccess(storage, target, "github");

		expect(consumeCloudAccountAccessIntent(storage)).toBe("github");
		expect(consumeCloudAccountAccessIntent(storage)).toBeNull();
	});

	it("drops malformed persisted values", () => {
		const storage = makeStorage();
		storage.setItem("zuse.cloudAccountAccess.intent", "not-a-provider");

		expect(consumeCloudAccountAccessIntent(storage)).toBeNull();
		expect(storage.length).toBe(0);
	});

	it("delivers a request when the settings surface is already mounted", () => {
		const storage = makeStorage();
		const target = new EventTarget();
		const received: string[] = [];
		const unsubscribe = subscribeToCloudAccountAccessIntent(
			storage,
			target,
			(providerId) => received.push(providerId),
		);

		requestCloudAccountAccess(storage, target, "github");
		unsubscribe();

		expect(received).toEqual(["github"]);
		expect(storage.length).toBe(0);
	});
});
