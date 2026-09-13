import { type CloudApiKey, CloudWorkspaceOpError } from "@zuse/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import {
	CloudApiKeyList,
	formatApiKeyError,
} from "../../src/components/settings/cloud-api-keys.tsx";

const renderList = (
	keys: ReadonlyArray<CloudApiKey> | null,
	loading = false,
	hasCreatedSecret = false,
	busy: string | null = null,
) =>
	renderToStaticMarkup(
		<CloudApiKeyList
			keys={keys}
			loading={loading}
			hasCreatedSecret={hasCreatedSecret}
			busy={busy}
			onRevoke={() => {}}
		/>,
	);

describe("Cloud API key settings", () => {
	test("does not claim an empty account after a failed initial load", () => {
		expect(renderList(null)).toBe("");
		expect(renderList(null, true)).toContain("Loading API keys");
		expect(renderList(null, true)).not.toContain("No API keys yet");
	});

	test("shows an empty account only after a successful list response", () => {
		expect(renderList([])).toContain("No API keys yet");
		expect(renderList([], false, true)).not.toContain("No API keys yet");
	});

	test("keeps known keys visible and blocks revocation during another action", () => {
		const key: CloudApiKey = {
			keyId: "key-smoke",
			name: "Slack",
			prefix: "zk_example",
			createdAt: 1,
			lastUsedAt: null,
			revokedAt: null,
		};
		const markup = renderList([key], false, false, "create");
		expect(markup).toContain("Slack");
		expect(markup).toContain("zk_example");
		expect(markup).toContain("Never used");
		expect(markup).toContain("disabled");
		expect(markup).not.toContain("No API keys yet");
	});

	test("explains endpoint errors without incorrectly blaming a workspace", () => {
		expect(
			formatApiKeyError(
				new CloudWorkspaceOpError({ code: "not-found" }),
				"fallback",
			),
		).toContain("server needs the API update");
		expect(
			formatApiKeyError(
				new CloudWorkspaceOpError({ code: "beta-access-required" }),
				"fallback",
			),
		).toBe("Zuse Cloud is currently invite-only.");
		expect(
			formatApiKeyError(new Error("internal detail"), "Could not load keys."),
		).toBe("Could not load keys.");
	});
});
