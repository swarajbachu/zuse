import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CloudImageProviders } from "../../src/components/settings/cloud-image-providers.tsx";

it("shows compact status buttons without expanding build history into settings", () => {
	const markup = renderToStaticMarkup(
		<CloudImageProviders
			providers={[
				{ providerId: "boxd", displayName: "boxd" },
				{ providerId: "e2b", displayName: "E2B" },
			]}
			images={[
				{
					providerId: "boxd",
					state: "ready",
					repositories: [],
					providers: [],
					builds: [],
					updatedAt: 1,
				},
			]}
		/>,
	);
	expect(markup).toContain("boxd");
	expect(markup).toContain("Ready");
	expect(markup).toContain("E2B");
	expect(markup).toContain("Checking");
	expect(markup.match(/>Open logs<\/span>/g)).toHaveLength(2);
	expect(markup.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
	expect(markup).not.toContain("Latest build");
	expect(markup).not.toContain("Previous builds");
});

it("distinguishes provider billing from the environment installed on the machine", () => {
	const markup = renderToStaticMarkup(
		<CloudImageProviders
			providers={[
				{ providerId: "boxd", displayName: "boxd", billingSource: "provider" },
				{ providerId: "e2b", displayName: "E2B", billingSource: "zuse" },
			]}
			images={[
				{
					providerId: "boxd",
					source: "custom-snapshot",
					state: "ready",
					repositories: [],
					providers: [],
					builds: [],
					updatedAt: 1,
				},
				{
					providerId: "e2b",
					source: "managed",
					state: "ready",
					repositories: [],
					providers: [],
					builds: [],
					updatedAt: 1,
				},
			]}
			selectedProvider="boxd"
			onSelectProvider={() => {}}
		/>,
	);
	expect(markup).toContain("Billed by your provider");
	expect(markup).toContain("Billed by Zuse");
	expect(markup).toContain("Your custom snapshot");
	expect(markup).toContain("Zuse image");
});
