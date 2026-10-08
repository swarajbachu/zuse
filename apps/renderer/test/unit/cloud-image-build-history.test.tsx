import type { CloudAccountImageBuildAttempt } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import { CloudImageBuildHistory } from "../../src/components/settings/cloud-image-build-history.tsx";

const build: CloudAccountImageBuildAttempt = {
	buildId: "build",
	state: "building",
	mode: "update",
	active: false,
	runtimeVersion: "v1",
	configurationDigest: "config",
	repositories: [],
	providers: [],
	createdAt: 1000,
	updatedAt: 7000,
};
const render = (value = build) =>
	renderToStaticMarkup(
		<CloudImageBuildHistory builds={[value]} expandLatest />,
	);
afterEach(() => vi.restoreAllMocks());
test("active duration uses wall time, not the last persisted update", () => {
	vi.spyOn(Date, "now").mockReturnValue(66000);
	expect(render()).toContain("1m 5s");
});
test("finished duration stays fixed", () => {
	vi.spyOn(Date, "now").mockReturnValue(66000);
	expect(render({ ...build, state: "ready" })).toContain("6s");
});
test("snapshot preparation is explicit even before logs arrive", () => {
	expect(render({ ...build, state: "sanitizing" })).toContain(
		"Preparing snapshot",
	);
});

test("custom snapshot inspection does not display managed build placeholders", () => {
	for (const state of ["building", "ready", "failed"] as const) {
		const markup = renderToStaticMarkup(
			<CloudImageBuildHistory
				builds={[{ ...build, state }]}
				latestSource="custom-snapshot"
				expandLatest
			/>,
		);
		expect(markup).toContain(
			state === "ready"
				? "Custom snapshot ready"
				: state === "failed"
					? "Snapshot could not be used (unknown)"
					: "Inspecting snapshot…",
		);
		expect(markup).not.toContain("Waiting for build output");
		expect(markup).not.toContain("Image update");
		expect(markup).not.toContain("Build completed");
	}
});

test("history labels each entry using its own source", () => {
	const markup = renderToStaticMarkup(
		<CloudImageBuildHistory
			builds={[
				{ ...build, buildId: "current", source: "managed" },
				{ ...build, buildId: "import", source: "custom-snapshot" },
				{ ...build, buildId: "old-build", source: "managed", mode: "rebuild" },
			]}
			latestSource="custom-snapshot"
			expandLatest
		/>,
	);
	expect(markup.match(/Image update/g)).toHaveLength(1);
	expect(markup).toContain("Clean rebuild");
	expect(markup).toContain("Inspecting snapshot…");
});

test("snapshot checks list repositories without managed runtime or agent details", () => {
	const markup = render({
		...build,
		state: "ready",
		source: "custom-snapshot",
		runtimeVersion: "20260927-1:connection:provider_internal",
		providers: [
			{ providerId: "grok", state: "connected" },
		] as CloudAccountImageBuildAttempt["providers"],
		repositories: [
			{
				projectId: "zuse",
				repositoryIdentity: "github.com/swarajbachu/zuse",
				displayName: "swarajbachu/zuse",
				defaultBranch: "main",
			},
		],
		logText: "Snapshot inspected.",
	});
	expect(markup).toContain("Snapshot check");
	expect(markup).toContain("swarajbachu/zuse");
	expect(markup).not.toContain("provider_internal");
	expect(markup).not.toContain("grok");
	expect(markup).not.toContain("Build settings");
});
