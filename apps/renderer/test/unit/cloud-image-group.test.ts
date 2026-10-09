import type { CloudAccountImage } from "@zuse/contracts";
import { expect, it, vi } from "vitest";
import {
	cloudImageGroupStatus,
	cloudImageReadyForProject,
	rebuildCloudImages,
	reconcileCloudImages,
} from "../../src/lib/cloud-image-group.ts";

const image = (
	providerId: string,
	state: CloudAccountImage["state"],
): CloudAccountImage => ({
	providerId,
	state,
	repositories: [],
	providers: [],
	builds: [],
	updatedAt: 1,
});

it("does not replace a queued rebuild with an older ready image", () => {
	const ready = image("box", "ready");
	const queued = { ...image("box", "building"), updatedAt: 20 };
	expect(reconcileCloudImages([queued], [ready])).toEqual([queued]);
	const completed = { ...ready, updatedAt: 30 };
	expect(reconcileCloudImages([queued], [completed])).toEqual([completed]);
	const failed = { ...queued, state: "failed" as const, updatedAt: 40 };
	expect(reconcileCloudImages([queued], [failed])).toEqual([failed]);
	expect(reconcileCloudImages([queued], [image("e2b", "ready")])).toEqual([
		image("e2b", "ready"),
	]);
});

it("only offers built images that contain the selected repository for new chats", () => {
	const built = {
		...image("boxd", "ready"),
		repositories: [
			{
				projectId: "project",
				repositoryIdentity: "github.com/example/repo",
				displayName: "example/repo",
				defaultBranch: "main",
			},
		],
	};
	expect(cloudImageReadyForProject(built, "project")).toBe(true);
	expect(
		cloudImageReadyForProject({ ...built, state: "outdated" }, "project"),
	).toBe(true);
	expect(cloudImageReadyForProject(built, "other-project")).toBe(false);
	expect(cloudImageReadyForProject(built, undefined)).toBe(false);
	expect(cloudImageReadyForProject(undefined, "project")).toBe(false);
	for (const state of [
		"not-built",
		"building",
		"failed",
		"auth-broken",
	] as const) {
		expect(cloudImageReadyForProject({ ...built, state }, "project")).toBe(
			false,
		);
	}
});

it("requires every available provider, including newly added ones, to be ready", () => {
	const images = [image("boxd", "ready")];
	expect(cloudImageGroupStatus(["boxd"], images)?.state).toBe("ready");
	expect(cloudImageGroupStatus(["boxd", "new"], images)).toBeNull();
	expect(
		cloudImageGroupStatus(
			["boxd", "new"],
			[...images, image("new", "not-built")],
		)?.state,
	).toBe("not-built");
	expect(
		cloudImageGroupStatus(["boxd", "new"], [...images, image("new", "ready")])
			?.state,
	).toBe("ready");
	expect(cloudImageGroupStatus([], images)).toBeNull();
});
it("keeps remaining builds visible and reports a partial failure after they finish", () => {
	expect(
		cloudImageGroupStatus(
			["boxd", "e2b"],
			[image("boxd", "failed"), image("e2b", "building")],
		)?.state,
	).toBe("building");
	expect(
		cloudImageGroupStatus(
			["boxd", "e2b"],
			[image("boxd", "failed"), image("e2b", "ready")],
		)?.state,
	).toBe("failed");
	expect(
		cloudImageGroupStatus(
			["e2b"],
			[image("boxd", "failed"), image("e2b", "ready")],
		)?.state,
	).toBe("ready");
});
it("requests each provider once and preserves accepted builds when another fails", async () => {
	const build = vi.fn(async (id: string) => {
		if (id === "e2b") throw new Error("offline");
		return image(id, "building");
	});
	const result = await rebuildCloudImages(
		["boxd", "e2b", "boat", "boxd"],
		build,
	);
	expect(build.mock.calls.map(([id]) => id)).toEqual(["boxd", "e2b", "boat"]);
	expect(result.images.map((item) => item.providerId)).toEqual([
		"boxd",
		"boat",
	]);
	expect(result.failedProviderIds).toEqual(["e2b"]);
});

it("preserves a saved image on partial failure while accepting successful provider updates", () => {
	const saved = image("box", "ready");
	const other = image("e2b", "building");
	const completed = { ...image("e2b", "ready"), updatedAt: 2 };
	expect(reconcileCloudImages([saved, other], [completed], false)).toEqual([
		completed,
		saved,
	]);
	expect(reconcileCloudImages([saved, other], [], false)).toEqual([
		saved,
		other,
	]);
	expect(reconcileCloudImages([saved, other], [completed], true)).toEqual([
		completed,
	]);
});
