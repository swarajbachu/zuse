import { CloudAccountImage } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
	CloudSnapshotAgentAuthentication,
	CloudSnapshotRepositories,
} from "../../src/components/settings/cloud-snapshot-access.tsx";

function image(
	gitAuthentication: "native" | "zuse",
	gitAccess: "readable" | "authentication-required" = "readable",
) {
	return new CloudAccountImage({
		source: "custom-snapshot",
		providerId: "boxd",
		state: "ready",
		providers: [],
		builds: [],
		updatedAt: 1,
		repositories: [
			{
				projectId: "repo",
				displayName: "acme/web",
				repositoryIdentity: "github.com/acme/web",
				defaultBranch: "main",
			},
		],
		snapshot: {
			snapshotId: "snapshot",
			runtimeUser: "developer",
			revision: "1",
			gitAuthentication,
			agentAuthentication: "native",
			repositories: [{ projectId: "repo", path: "/work/web", gitAccess }],
		},
	});
}
it("lists each discovered repository once with its path and Git access", () => {
	const markup = renderToStaticMarkup(
		<CloudSnapshotRepositories image={image("native")} />,
	);
	expect(markup).toContain("acme/web");
	expect(markup).toContain("/work/web");
	expect(markup).toContain("Ready");
	expect(markup).toContain("From snapshot");
	expect(markup.match(/acme\/web/g)).toHaveLength(1);
	expect(markup).not.toContain("selected for cloud image");
});
it("labels the GitHub source chosen for the snapshot", () => {
	const markup = renderToStaticMarkup(
		<CloudSnapshotRepositories image={image("zuse")} />,
	);
	expect(markup).toContain("Zuse GitHub");
	expect(markup).not.toContain("From snapshot");
});
it("directs missing Git credentials to the selected authentication source", () => {
	const native = renderToStaticMarkup(
		<CloudSnapshotRepositories
			image={image("native", "authentication-required")}
		/>,
	);
	expect(native).toContain("sign in with gh on your source machine");
	expect(native).toContain("Needs attention");
	expect(
		renderToStaticMarkup(
			<CloudSnapshotRepositories
				image={image("zuse", "authentication-required")}
			/>,
		),
	).toContain("connect GitHub in Cloud settings");
});
it("explains snapshot agent logins without claiming a Zuse account connection", () => {
	const markup = renderToStaticMarkup(<CloudSnapshotAgentAuthentication />);
	expect(markup).toContain(
		"Claude Code and Codex use the logins on your snapshot",
	);
	expect(markup).not.toContain("Reauthorize");
});
