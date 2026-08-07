import { describe, expect, it } from "vitest";

import { applyClaudeCredentialEnv } from "../../../src/drivers/claude.ts";

describe("Claude managed credentials", () => {
	it("maps API keys and subscription tokens to mutually exclusive variables", () => {
		expect(
			applyClaudeCredentialEnv(
				{ EXISTING: "value" },
				{ kind: "api-key", secret: "api-secret" },
			),
		).toEqual({ EXISTING: "value", ANTHROPIC_API_KEY: "api-secret" });
		expect(
			applyClaudeCredentialEnv(
				{ ANTHROPIC_API_KEY: "inherited" },
				{ kind: "oauth-token", secret: "oauth-secret" },
			),
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret" });
	});

	it("leaves native CLI authentication untouched when no credential is managed", () => {
		expect(applyClaudeCredentialEnv({ EXISTING: "value" }, null)).toEqual({
			EXISTING: "value",
		});
	});
});
