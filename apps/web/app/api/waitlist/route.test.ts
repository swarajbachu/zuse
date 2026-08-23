import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, OPTIONS, POST, PUT } from "./route";

const request = (body: string, contentType = "application/json") =>
	new Request("https://zuse.sh/api/waitlist", {
		method: "POST",
		headers: { "Content-Type": contentType },
		body,
	});

describe("waitlist API", () => {
	const originalWebhook = process.env.WAITLIST_WEBHOOK_URL;

	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => undefined);
		delete process.env.WAITLIST_WEBHOOK_URL;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		if (originalWebhook) {
			process.env.WAITLIST_WEBHOOK_URL = originalWebhook;
		} else {
			delete process.env.WAITLIST_WEBHOOK_URL;
		}
	});

	it("rejects non-JSON requests with a structured error", async () => {
		const response = await POST(request("email=a@b.com", "text/plain"));
		expect(response.status).toBe(415);
		expect(await response.json()).toMatchObject({
			error: { code: "UNSUPPORTED_MEDIA_TYPE", resolution: expect.any(String) },
		});
	});

	it("distinguishes malformed JSON from an invalid email", async () => {
		const malformed = await POST(request("{"));
		expect(malformed.status).toBe(400);
		expect(await malformed.json()).toMatchObject({
			error: { code: "INVALID_JSON" },
		});

		const invalidEmail = await POST(request('{"email":"nope"}'));
		expect(invalidEmail.status).toBe(400);
		expect(await invalidEmail.json()).toMatchObject({
			error: { code: "INVALID_EMAIL" },
		});
	});

	it("accepts JSON media types case-insensitively", async () => {
		const response = await POST(
			request('{"email":"nope"}', "Application/JSON; Charset=UTF-8"),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({
			error: { code: "INVALID_EMAIL" },
		});
	});

	it("returns an actionable unavailable response when no sink is configured", async () => {
		const response = await POST(request('{"email":"dev@example.com"}'));
		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			error: { code: "SERVICE_UNAVAILABLE" },
		});
	});

	it("forwards valid signups and preserves the success response", async () => {
		process.env.WAITLIST_WEBHOOK_URL = "https://sink.example/waitlist";
		const fetchMock = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetchMock);

		const response = await POST(request('{"email":"dev@example.com"}'));
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://sink.example/waitlist",
			expect.objectContaining({ method: "POST" }),
		);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
		expect(JSON.parse(String(init.body))).toMatchObject({
			email: "dev@example.com",
			source: "zuse-cloud-waitlist",
			timestamp: expect.any(String),
		});
	});

	it("returns a structured upstream error without claiming success", async () => {
		process.env.WAITLIST_WEBHOOK_URL = "https://sink.example/waitlist";
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(new Response(null, { status: 500 })),
		);

		const response = await POST(request('{"email":"dev@example.com"}'));
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: { code: "UPSTREAM_ERROR" },
		});
	});

	it("returns the same structured error when the waitlist request throws", async () => {
		process.env.WAITLIST_WEBHOOK_URL = "https://sink.example/waitlist";
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

		const response = await POST(request('{"email":"dev@example.com"}'));
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({
			error: { code: "UPSTREAM_ERROR", resolution: expect.any(String) },
		});
	});

	it("describes the supported method for GET callers", async () => {
		const response = GET();
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(await response.json()).toMatchObject({
			error: { code: "METHOD_NOT_ALLOWED" },
		});
	});

	it("returns structured errors for every unsupported method", async () => {
		const response = PUT();
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
		expect(await response.json()).toMatchObject({
			error: { code: "METHOD_NOT_ALLOWED", resolution: expect.any(String) },
		});
	});

	it("returns an explicit preflight contract", () => {
		const response = OPTIONS();
		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-methods")).toBe("POST");
	});
});
