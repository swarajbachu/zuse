import { makeResourceKey } from "@zuse/client-runtime/resource-ref";
import { EnvironmentId } from "@zuse/contracts";
import { describe, expect, it } from "vitest";

import { makeLocalStorageResourcePersistence } from "../../src/lib/storage-resource-persistence.ts";

class MemoryStorage {
	readonly values = new Map<string, string>();

	getItem(key: string): string | null {
		return this.values.get(key) ?? null;
	}

	setItem(key: string, value: string): void {
		this.values.set(key, value);
	}

	removeItem(key: string): void {
		this.values.delete(key);
	}
}

const keyFor = (environmentId: string) =>
	makeResourceKey<{ readonly onboardingCompleted: boolean }>(
		"environment-settings",
		{ environmentId: EnvironmentId.make(environmentId) },
	);

const makePersistence = (storage: MemoryStorage) =>
	makeLocalStorageResourcePersistence({
		storage: () => storage,
		prefix: "test.settings",
		version: 1,
		decode: (value) => {
			if (
				typeof value !== "object" ||
				value === null ||
				typeof (value as { onboardingCompleted?: unknown })
					.onboardingCompleted !== "boolean"
			) {
				throw new Error("invalid settings");
			}
			return value as { readonly onboardingCompleted: boolean };
		},
	});

describe("local-storage resource persistence", () => {
	it("round-trips versioned resources and isolates environments", async () => {
		const storage = new MemoryStorage();
		const persistence = makePersistence(storage);
		const local = keyFor("local");
		const remote = keyFor("remote");

		await persistence.saveResource(local, {
			data: { onboardingCompleted: true },
			cursor: { epoch: "settings:1", version: 1 },
			storedAt: 123,
		});

		expect(await persistence.loadResource(local)).toEqual({
			data: { onboardingCompleted: true },
			cursor: { epoch: "settings:1", version: 1 },
			storedAt: 123,
		});
		expect(await persistence.loadResource(remote)).toBeNull();
	});

	it("drops malformed and stale-version cache entries", async () => {
		const storage = new MemoryStorage();
		const persistence = makePersistence(storage);
		const key = keyFor("local");
		await persistence.saveResource(key, {
			data: { onboardingCompleted: true },
			cursor: null,
			storedAt: 1,
		});
		const [storageKey] = storage.values.keys();
		if (storageKey === undefined) throw new Error("cache key missing");
		storage.values.set(storageKey, JSON.stringify({ version: 0 }));

		expect(await persistence.loadResource(key)).toBeNull();
		expect(storage.values.has(storageKey)).toBe(false);

		await persistence.saveResource(key, {
			data: { onboardingCompleted: true },
			cursor: null,
			storedAt: 2,
		});
		storage.values.set(storageKey, "not-json");
		expect(await persistence.loadResource(key)).toBeNull();
		expect(storage.values.has(storageKey)).toBe(false);
	});

	it("rejects cached data that fails the resource decoder", async () => {
		const storage = new MemoryStorage();
		const persistence = makePersistence(storage);
		const key = keyFor("local");
		await persistence.saveResource(key, {
			data: { onboardingCompleted: true },
			cursor: null,
			storedAt: 1,
		});
		const [storageKey] = storage.values.keys();
		if (storageKey === undefined) throw new Error("cache key missing");
		const envelope = JSON.parse(storage.values.get(storageKey) ?? "{}") as {
			resource?: { data?: unknown };
		};
		if (envelope.resource === undefined) throw new Error("resource missing");
		envelope.resource.data = { onboardingCompleted: "yes" };
		storage.values.set(storageKey, JSON.stringify(envelope));

		expect(await persistence.loadResource(key)).toBeNull();
		expect(storage.values.has(storageKey)).toBe(false);
	});
});
