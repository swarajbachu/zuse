import { siteConfig } from "@/lib/seo";

const errorResponse = (description: string) => ({
	description,
	content: {
		"application/json": {
			schema: { $ref: "#/components/schemas/ErrorResponse" },
		},
	},
});

export const openApiDocument = {
	openapi: "3.1.0",
	info: {
		title: "Zuse Public Web API",
		version: "1.0.0",
		description:
			"The machine-readable contract for Zuse's public website API. The current API only registers interest in Zuse Cloud; desktop sessions and provider credentials are not exposed over this API.",
	},
	servers: [{ url: siteConfig.url, description: "Zuse website" }],
	paths: {
		"/api/waitlist": {
			post: {
				operationId: "registerCloudWaitlistInterest",
				summary: "Register interest in Zuse Cloud",
				description:
					"Submits an email address for Zuse Cloud beta updates. This endpoint does not create an account or grant product access.",
				requestBody: {
					required: true,
					description: "The email address to register.",
					content: {
						"application/json": {
							schema: { $ref: "#/components/schemas/WaitlistRequest" },
						},
					},
				},
				responses: {
					"200": {
						description: "The email address was registered successfully.",
						content: {
							"application/json": {
								schema: { $ref: "#/components/schemas/WaitlistSuccess" },
							},
						},
					},
					"400": errorResponse(
						"The request body is invalid JSON or contains an invalid email address.",
					),
					"415": errorResponse(
						"The request does not use the application/json media type.",
					),
					"502": errorResponse(
						"The configured waitlist service rejected or could not receive the signup.",
					),
					"503": errorResponse(
						"Waitlist registration is temporarily unavailable.",
					),
				},
			},
		},
	},
	components: {
		schemas: {
			WaitlistRequest: {
				type: "object",
				description: "A request to receive Zuse Cloud beta updates.",
				additionalProperties: false,
				required: ["email"],
				properties: {
					email: {
						type: "string",
						format: "email",
						maxLength: 254,
						description: "The email address to register.",
					},
				},
			},
			WaitlistSuccess: {
				type: "object",
				description: "Confirms that the signup was accepted.",
				additionalProperties: false,
				required: ["ok"],
				properties: {
					ok: {
						type: "boolean",
						const: true,
						description: "Always true when registration succeeds.",
					},
				},
			},
			ErrorDetail: {
				type: "object",
				description: "A structured, actionable API error.",
				additionalProperties: false,
				required: ["code", "message", "resolution"],
				properties: {
					code: {
						type: "string",
						description: "A stable, machine-readable error identifier.",
					},
					message: {
						type: "string",
						description: "A concise explanation of the error.",
					},
					resolution: {
						type: "string",
						description: "The action a caller can take to resolve the error.",
					},
				},
			},
			ErrorResponse: {
				type: "object",
				description: "The error envelope returned by the Zuse public web API.",
				additionalProperties: false,
				required: ["error"],
				properties: {
					error: { $ref: "#/components/schemas/ErrorDetail" },
				},
			},
		},
	},
} as const;
