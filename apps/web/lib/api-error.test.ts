import { describe, expect, it } from "vitest";
import { jsonError } from "./api-error";

describe("jsonError", () => {
	it("returns an actionable JSON error envelope", async () => {
		const response = jsonError(
			404,
			"NOT_FOUND",
			"Missing endpoint.",
			"Read /openapi.json.",
		);

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.json()).toEqual({
			error: {
				code: "NOT_FOUND",
				message: "Missing endpoint.",
				resolution: "Read /openapi.json.",
			},
		});
	});
});
