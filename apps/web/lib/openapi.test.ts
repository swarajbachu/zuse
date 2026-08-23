import { describe, expect, it } from "vitest";
import { openApiDocument } from "./openapi";

describe("Zuse OpenAPI document", () => {
	it("uses OpenAPI 3.1 and documents the public waitlist operation", () => {
		expect(openApiDocument.openapi).toBe("3.1.0");
		const operation = openApiDocument.paths["/api/waitlist"].post;
		expect(operation.operationId).toBe("registerCloudWaitlistInterest");
		expect(operation.description.length).toBeGreaterThan(40);
		expect(operation.requestBody.required).toBe(true);
		expect(operation.responses["200"].description).toBeTruthy();
		expect(operation.responses["400"].description).toBeTruthy();
	});

	it("defines typed request, success, and actionable error schemas", () => {
		const { schemas } = openApiDocument.components;
		expect(schemas.WaitlistRequest.properties.email).toMatchObject({
			type: "string",
			format: "email",
			maxLength: 254,
		});
		expect(schemas.WaitlistSuccess.properties.ok).toMatchObject({
			type: "boolean",
			const: true,
		});
		expect(schemas.ErrorDetail.required).toEqual([
			"code",
			"message",
			"resolution",
		]);
	});

	it("keeps every operation id unique and every operation described", () => {
		const operations = Object.values(openApiDocument.paths).flatMap((path) =>
			Object.values(path),
		);
		const operationIds = operations.map((operation) => operation.operationId);
		expect(new Set(operationIds).size).toBe(operationIds.length);
		for (const operation of operations) {
			expect(operation.description).toBeTruthy();
		}
	});
});
