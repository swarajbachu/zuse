import { beforeEach, describe, expect, test, vi } from "vitest";

import {
	clearDeviceIdentity,
	deviceLabel,
	getOrCreateDeviceId,
} from "../../../src/lib/device-identity";

const secureStore = vi.hoisted(() => {
	let stored: string | null = null;
	return {
		getItemAsync: vi.fn(async () => stored),
		setItemAsync: vi.fn(async (_key: string, value: string) => {
			stored = value;
		}),
		deleteItemAsync: vi.fn(async () => {
			stored = null;
		}),
		reset: () => {
			stored = null;
		},
	};
});

vi.mock("expo-secure-store", () => secureStore);
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

describe("mobile device identity", () => {
	beforeEach(() => {
		secureStore.reset();
		secureStore.getItemAsync.mockClear();
		secureStore.setItemAsync.mockClear();
		secureStore.deleteItemAsync.mockClear();
		vi.stubGlobal("crypto", {
			randomUUID: vi
				.fn()
				.mockReturnValueOnce("first")
				.mockReturnValueOnce("second"),
		});
	});

	test("serializes concurrent creation so pairing and push share one id", async () => {
		const [pairingId, pushId] = await Promise.all([
			getOrCreateDeviceId(),
			getOrCreateDeviceId(),
		]);

		expect(pairingId).toBe("mobile_first");
		expect(pushId).toBe(pairingId);
		expect(secureStore.getItemAsync).toHaveBeenCalledTimes(1);
		expect(secureStore.setItemAsync).toHaveBeenCalledTimes(1);
	});

	test("full-reset identity clearing creates a new phone id", async () => {
		await expect(getOrCreateDeviceId()).resolves.toBe("mobile_first");
		await clearDeviceIdentity();
		await expect(getOrCreateDeviceId()).resolves.toBe("mobile_second");
	});

	test("full reset waits for an in-flight identity write before deleting", async () => {
		let finishWrite: (() => void) | undefined;
		secureStore.setItemAsync.mockImplementationOnce(
			async (_key: string, value: string) =>
				await new Promise<void>((resolve) => {
					finishWrite = () => {
						secureStore.reset();
						void secureStore.setItemAsync(_key, value).then(resolve);
					};
				}),
		);
		const creating = getOrCreateDeviceId();
		await vi.waitFor(() => expect(finishWrite).toBeTypeOf("function"));
		const clearing = clearDeviceIdentity();
		finishWrite?.();
		await Promise.all([creating, clearing]);

		await expect(getOrCreateDeviceId()).resolves.toBe("mobile_second");
	});

	test("uses a user-facing platform label", () => {
		expect(deviceLabel()).toBe("iPhone");
	});
});
