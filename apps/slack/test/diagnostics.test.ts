import { expect, it } from "vitest";
import { errorDiagnostics } from "../src/diagnostics.ts";
import { SlackApiError } from "../src/slack.ts";
import { createWorkspace, ZuseApiError } from "../src/zuse.ts";

it("captures API status, error code and operation without sensitive response fields", async () => {
	try {
		await createWorkspace(
			{
				request: async () =>
					Response.json(
						{
							code: "cloud_provider_auth_required",
							message: "SECRET",
							token: "zk_private",
						},
						{ status: 403 },
					),
			},
			{ idempotencyKey: "private-key" },
		);
		throw new Error("Expected rejection");
	} catch (error) {
		expect(errorDiagnostics(error)).toEqual({
			errorType: "ZuseApiError",
			status: 403,
			code: "cloud_provider_auth_required",
			operation: "workspace_create",
			retryable: false,
		});
	}
});
it.each([
	"zk_private",
	"sk_private",
	"secret_value",
	"private message",
	"https://private.test",
	"x".repeat(200),
	{ secret: "private" },
])("does not log arbitrary error values: %s", (code) => {
	const result = errorDiagnostics(
		new ZuseApiError(400, JSON.stringify({ code, message: "private" })),
	);
	expect(result).toMatchObject({ code: "unclassified_api_error" });
});
it("ignores non-JSON bodies and unknown error messages and names", () => {
	expect(
		errorDiagnostics(new ZuseApiError(502, "private upstream response")),
	).toMatchObject({ code: "unclassified_api_error" });
	const error = new Error("private body");
	error.name = "private name";
	expect(errorDiagnostics(error)).toEqual({ errorType: "UnexpectedError" });
	expect(
		errorDiagnostics(new SlackApiError("missing_scope", 200)),
	).toMatchObject({ code: "missing_scope" });
});
