import type { CloudAccountImage, CloudProject } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
	CloudImageReadiness,
	cloudImageChangeSummary,
} from "../../src/components/settings/cloud-image-readiness.tsx";

const project: CloudProject = {
	projectId: "project-1",
	repositoryIdentity: "github.com/acme/app",
	repositoryUrl: "https://github.com/acme/app",
	displayName: "acme/app",
	defaultBranch: "main",
	visibility: "private",
	state: "connected",
	activeBuilds: {},
	latestBuilds: {},
	createdAt: 50,
	updatedAt: 300,
};

const image = (state: CloudAccountImage["state"]): CloudAccountImage => ({
	state,
	generation: "build-1",
	providerId: "e2b",
	runtimeVersion: "runtime-1",
	buildMode: "update",
	repositories: [],
	providers: [],
	builds: [
		{
			buildId: "build-1",
			state: "ready",
			mode: "update",
			active: true,
			runtimeVersion: "runtime-1",
			configurationDigest: "digest",
			repositories: [],
			providers: [],
			createdAt: 100,
			updatedAt: 200,
		},
	],
	builtAt: 200,
	updatedAt: 300,
});

describe("CloudImageReadiness", () => {
	it.each([
		false,
		true,
	])("only enables rebuilding a ready image when Cloud is available (unavailable=%s)", (unavailable) => {
		const markup = renderToStaticMarkup(
			<CloudImageReadiness
				image={image("ready")}
				projects={[project]}
				busy={null}
				unavailable={unavailable}
				onBuild={() => undefined}
			/>,
		);
		expect(markup).toContain("Rebuild image");
		const button = markup.match(/<button[^>]*>/u)?.[0];
		expect(button).toBeDefined();
		expect(button?.includes("disabled=")).toBe(unavailable);
	});

	it("shows repository changes as a single obvious update action", () => {
		const outdated = image("outdated");
		expect(cloudImageChangeSummary(outdated, [project])).toEqual([
			"repositories",
		]);
		const markup = renderToStaticMarkup(
			<CloudImageReadiness
				image={outdated}
				projects={[project]}
				busy={null}
				unavailable={false}
				onBuild={() => undefined}
			/>,
		);
		expect(markup).toContain("Unbuilt changes");
		expect(markup).toContain("Changed: repositories.");
		expect(markup).toContain("Update image");
		expect(markup).toContain("h-7");
		expect(markup).not.toContain("min-h-8");
		expect(markup).not.toContain("min-h-11");
	});

	it("uses explicit rebuild language when authentication is broken", () => {
		const markup = renderToStaticMarkup(
			<CloudImageReadiness
				image={image("auth-broken")}
				projects={[project]}
				busy={null}
				unavailable={false}
				onBuild={() => undefined}
			/>,
		);
		expect(markup).toContain("Rebuild required");
		expect(markup).toContain("Reconnect the affected agent");
		expect(markup).toContain("Rebuild image");
	});
});
