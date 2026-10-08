import { CloudAccountImage } from "@zuse/contracts";
import { describe, expect, it, test } from "vitest";
import {
	cloudOnboardingCompleted,
	cloudOnboardingRequired,
	completeCloudOnboarding,
	firstIncompleteCloudStep,
	readyCloudOnboardingSnapshot,
} from "../../src/lib/cloud-onboarding.ts";

describe("cloud onboarding eligibility", () => {
	it("opens when payment activates and setup has not been completed", () => {
		expect(
			cloudOnboardingRequired({
				subscribed: false,
				completed: false,
				hasExistingImage: false,
			}),
		).toBe(false);
		expect(
			cloudOnboardingRequired({
				subscribed: true,
				completed: false,
				hasExistingImage: false,
			}),
		).toBe(true);
	});
	it("does not interrupt users who already completed setup or have a working image", () => {
		expect(
			cloudOnboardingRequired({
				subscribed: true,
				completed: true,
				hasExistingImage: false,
			}),
		).toBe(false);
		expect(
			cloudOnboardingRequired({
				subscribed: true,
				completed: false,
				hasExistingImage: true,
			}),
		).toBe(false);
	});
	it("resumes at the first unfinished server-backed step", () => {
		expect(
			firstIncompleteCloudStep({ github: false, auth: false, image: false }),
		).toBe("github");
		expect(
			firstIncompleteCloudStep({ github: true, auth: false, image: false }),
		).toBe("auth");
		expect(
			firstIncompleteCloudStep({ github: true, auth: true, image: false }),
		).toBe("image");
	});
	it("persists completion per account across app launches", () => {
		const values = new Map<string, string>();
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
		};
		expect(cloudOnboardingCompleted(storage, "alice")).toBe(false);
		completeCloudOnboarding(storage, "alice");
		expect(cloudOnboardingCompleted(storage, "alice")).toBe(true);
		expect(cloudOnboardingCompleted(storage, "bob")).toBe(false);
	});
	it("keeps setup usable when storage is unavailable", () => {
		const storage = {
			getItem: () => {
				throw new Error("unavailable");
			},
			setItem: () => {
				throw new Error("unavailable");
			},
		};
		expect(cloudOnboardingCompleted(storage, "alice")).toBe(false);
		expect(() => completeCloudOnboarding(storage, "alice")).not.toThrow();
	});
});

test("snapshot onboarding prerequisites belong to the selected provider", () => {
	const image = new CloudAccountImage({
		providerId: "boxd",
		state: "ready",
		updatedAt: 1,
		repositories: [],
		providers: [],
		builds: [],
		snapshot: {
			snapshotId: "snapshot",
			runtimeUser: "developer",
			revision: "1",
			repositories: [],
			agentAuthentication: "native",
			gitAuthentication: "native",
		},
	});
	const images = [image];
	expect(readyCloudOnboardingSnapshot(images, "e2b")).toBeUndefined();
	expect(readyCloudOnboardingSnapshot(images, null)).toBeUndefined();
	expect(readyCloudOnboardingSnapshot(images, "boxd")).toEqual(
		images[0]?.snapshot,
	);
	expect(
		readyCloudOnboardingSnapshot([{ ...image, state: "building" }], "boxd"),
	).toBeUndefined();
});
