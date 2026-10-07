import { CloudAccountImage } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CloudImageReadiness } from "../../src/components/settings/cloud-image-readiness.tsx";
import { CloudSnapshotSettings } from "../../src/components/settings/cloud-snapshot-settings.tsx";

test("snapshot setup offers discovery, explicit paths and separate agent/Git authentication choices", () => {
	const markup = renderToStaticMarkup(
		<CloudSnapshotSettings connectionId="own-key" onChanged={async () => {}} />,
	);
	expect(markup).toContain("Leave paths empty");
	expect(markup).toContain("Add repository path");
	expect(markup).toContain("Use my Zuse GitHub connection for Git and gh");
	expect(markup).toContain("Use my Zuse agent accounts for new workspaces");
	expect(markup).not.toContain("--repo");
	expect(markup).not.toContain("Subscribe");
	for (const control of markup.match(/<(?:input|button)[^>]*>/g) ?? [])
		if (!control.includes('type="checkbox"')) expect(control).toContain("h-7");
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
