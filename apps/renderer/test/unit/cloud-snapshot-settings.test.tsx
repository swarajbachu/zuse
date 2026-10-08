import { CloudAccountImage } from "@zuse/contracts";
import { activateLocale, prepareLocale } from "@zuse/i18n";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, test, vi } from "vitest";
import * as cloudCache from "../../src/lib/cloud-workspace-session-cache.ts";

afterEach(() => vi.restoreAllMocks());

import { CloudImageReadiness } from "../../src/components/settings/cloud-image-readiness.tsx";
import { CloudSnapshotSettings } from "../../src/components/settings/cloud-snapshot-settings.tsx";

test("snapshot setup offers discovery, explicit paths and separate agent/Git authentication choices", () => {
	const markup = renderToStaticMarkup(
		<CloudSnapshotSettings connectionId="own-key" onChanged={async () => {}} />,
	);
	expect(markup).toContain("npx zusehq snapshot install");
	expect(markup).toContain('placeholder="Snapshot name or ID"');
	expect(markup).toContain("Repository paths: found automatically");
	expect(markup).toContain("Use logins from snapshot");
	expect(markup).toContain("Use credentials from snapshot");
	// On means "use what is already in the snapshot", the default for both.
	expect(markup.match(/role="switch"[^>]*aria-checked="true"/g)).toHaveLength(
		2,
	);
	expect(markup).toContain("On: Claude Code and Codex use the logins");
	expect(markup).toContain("On: Git and gh use the credentials");
	expect(markup).not.toContain("--repo");
	expect(markup).not.toContain("Subscribe");
	for (const control of markup.match(/<(?:input|button)[^>]*>/g) ?? [])
		if (
			!control.includes('data-slot="switch"') &&
			!control.includes("tooltip") &&
			// Base UI's visually hidden form input behind each switch.
			!control.includes("clip-path")
		)
			expect(control).toMatch(/h-7|size-6/);
});
test("imported snapshots never offer a managed-image rebuild action", () => {
	const image = new CloudAccountImage({
		state: "ready",
		source: "custom-snapshot",
		providerId: "boxd",
		repositories: [],
		providers: [],
		builds: [],
		updatedAt: 1,
	});
	const markup = renderToStaticMarkup(
		<CloudImageReadiness
			image={image}
			projects={[]}
			busy={null}
			unavailable={false}
			onBuild={() => {
				throw new Error("Unexpected build");
			}}
		/>,
	);
	expect(markup).toContain("Custom snapshot ready");
	expect(markup).not.toContain("Rebuild");
});

test("snapshot settings translate labels while preserving the installation command", async () => {
	await prepareLocale("fr", ["settings"]);
	await activateLocale("fr");
	try {
		const markup = renderToStaticMarkup(
			<CloudSnapshotSettings
				connectionId="own-key"
				onChanged={async () => {}}
			/>,
		);
		expect(markup).toContain("Connexions des agents");
		expect(markup).toContain("Chemins des dépôts");
		expect(markup).toContain("npx zusehq snapshot install");
		expect(markup).not.toContain("settings:snapshot_");
	} finally {
		await activateLocale("en");
	}
});

test("opens the editor with locally cached snapshot fields before any request", () => {
	vi.spyOn(cloudCache, "peekCloudImage").mockReturnValue(
		new CloudAccountImage({
			state: "ready",
			source: "custom-snapshot",
			providerId: "boxd",
			repositories: [],
			providers: [],
			builds: [],
			updatedAt: 1,
			snapshot: {
				snapshotId: "snap_cached",
				runtimeUser: "developer",
				revision: "saved",
				repositories: [
					{ projectId: "repo", path: "/srv/my repo", gitAccess: "readable" },
				],
				agentAuthentication: "zuse",
				gitAuthentication: "native",
			},
		}),
	);
	const markup = renderToStaticMarkup(
		<CloudSnapshotSettings connectionId="own-key" onChanged={async () => {}} />,
	);
	expect(markup).toContain('value="snap_cached"');
	expect(markup).toContain('value="developer"');
	expect(markup).toContain("Repository paths (1)");
	expect(markup.match(/role="switch"[^>]*aria-checked="false"/g)).toHaveLength(
		1,
	);
	expect(markup.match(/role="switch"[^>]*aria-checked="true"/g)).toHaveLength(
		1,
	);
});
