import { ApiEnvironmentRecord, EnvironmentId } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { HostedDevicesPane } from "../../src/components/settings/hosted-devices-pane.tsx";

const discovery = vi.hoisted(() => ({
	computers: [] as ApiEnvironmentRecord[],
	loading: false,
	failed: false,
	refresh: vi.fn(),
}));
vi.mock("../../src/hooks/use-hosted-computers.ts", () => ({
	useHostedComputers: () => discovery,
}));
beforeEach(() => {
	discovery.computers = [];
	discovery.loading = false;
	discovery.failed = false;
});
it("offers computer setup without requiring any laptop connection", () => {
	const html = renderToStaticMarkup(<HostedDevicesPane />);
	expect(html).toContain("Add computer");
	expect(html).toContain("No other computers yet");
	expect(html).toContain("Refresh computers");
});
it("shows linked personal computers and a chat action", () => {
	discovery.computers = [
		ApiEnvironmentRecord.make({
			environmentId: EnvironmentId.make("laptop-1"),
			providerKind: "desktop",
			label: "My laptop",
			linkedAt: 1,
		}),
	];
	const html = renderToStaticMarkup(<HostedDevicesPane />);
	expect(html).toContain("My laptop");
	expect(html).toContain("Show chats");
});
it("keeps the computer list visible when discovery temporarily fails", () => {
	discovery.computers = [
		ApiEnvironmentRecord.make({
			environmentId: EnvironmentId.make("laptop-1"),
			providerKind: "desktop",
			label: "My laptop",
			linkedAt: 1,
		}),
	];
	discovery.failed = true;
	const html = renderToStaticMarkup(<HostedDevicesPane />);
	expect(html).toContain("My laptop");
	expect(html).toContain('role="alert"');
	expect(html).toContain("Retry");
});
