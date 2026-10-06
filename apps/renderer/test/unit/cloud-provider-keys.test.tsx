import type { CloudProviderConnection } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
	CloudProviderKeyList,
	CloudProviderKeys,
} from "../../src/components/settings/cloud-provider-keys.tsx";

const connection = (
	overrides: Partial<CloudProviderConnection> = {},
): CloudProviderConnection =>
	({
		connectionId: "conn_1",
		providerId: "e2b",
		active: true,
		createdAt: Date.UTC(2026, 8, 1),
		...overrides,
	}) as CloudProviderConnection;

const renderList = (
	connections: readonly CloudProviderConnection[] | null,
	{ loading = false, loadError = false, busy = null as string | null } = {},
) =>
	renderToStaticMarkup(
		<CloudProviderKeyList
			connections={connections}
			loading={loading}
			loadError={loadError}
			busy={busy}
			onRetry={() => {}}
			onDisconnect={() => {}}
		/>,
	);

describe("Cloud provider key settings", () => {
	test("starts in a loading state with the connect form", () => {
		const markup = renderToStaticMarkup(
			<CloudProviderKeys onChanged={async () => {}} />,
		);
		expect(markup).toContain("Loading provider keys");
		expect(markup).toContain("Connect a provider");
		expect(markup).toContain("boxd API key");
	});

	test("does not claim an empty account after a failed load", () => {
		const markup = renderList(null, { loadError: true });
		expect(markup).toContain("Provider keys could not be loaded");
		expect(markup).toContain("Retry");
		expect(markup).not.toContain("No provider key connected");
	});

	test("shows the empty state only after a successful list response", () => {
		expect(renderList([])).toContain("No provider key connected");
		expect(renderList([connection({ active: false })])).toContain(
			"No provider key connected",
		);
	});

	test("lists active keys with their options and blocks disconnect during another action", () => {
		const markup = renderList(
			[
				connection({
					providerId: "boxd",
					templateId: "tpl_custom",
					organization: "acme",
				}),
				connection({ connectionId: "conn_old", active: false }),
			],
			{ busy: "save" },
		);
		expect(markup).toContain("boxd");
		expect(markup).toContain("Connected");
		expect(markup).toContain("Template tpl_custom");
		expect(markup).toContain("Organization acme");
		expect(markup).toContain('aria-label="Disconnect boxd key"');
		expect(markup).toContain("disabled");
		expect(markup).not.toContain("E2B");
	});
});
