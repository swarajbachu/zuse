import type { CloudProviderConnection } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
	CloudProviderConnectForm,
	type CloudProviderConnections,
	CloudProviderKeyList,
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
	const keys = (
		active: readonly CloudProviderConnection[],
	): CloudProviderConnections => ({
		connections: active,
		active: [...active],
		customSnapshotsEnabled: false,
		loading: false,
		loadError: false,
		reload: async () => {},
		apply: () => {},
	});

	test("defaults the connect form to boxd and offers replacement for a connected provider", () => {
		const empty = renderToStaticMarkup(
			<CloudProviderConnectForm keys={keys([])} onChanged={async () => {}} />,
		);
		expect(empty).toContain("boxd API key");
		expect(empty).toContain("Connect");
		expect(empty).toContain('aria-label="Sandbox provider"');
		const replacing = renderToStaticMarkup(
			<CloudProviderConnectForm
				keys={keys([connection({ providerId: "boxd" })])}
				providerId="boxd"
				onChanged={async () => {}}
			/>,
		);
		expect(replacing).toContain("Replace");
		expect(replacing).not.toContain('aria-label="Sandbox provider"');
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
