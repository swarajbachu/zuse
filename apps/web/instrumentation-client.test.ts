import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({ init: vi.fn(), capture: vi.fn() }));
vi.mock("posthog-js", () => ({ default: sdk }));

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
	vi.stubEnv("NODE_ENV", "production");
	vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "public-test-key");
	vi.stubEnv("NEXT_PUBLIC_POSTHOG_HOST", "https://eu.i.posthog.com");
	vi.stubGlobal("navigator", {});
	vi.stubGlobal("document", { addEventListener: vi.fn() });
});
afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("website analytics startup", () => {
	it("initializes the configured project in production", async () => {
		await import("./instrumentation-client");
		await vi.waitFor(() =>
			expect(sdk.init).toHaveBeenCalledWith(
				"public-test-key",
				expect.objectContaining({ api_host: "https://eu.i.posthog.com" }),
			),
		);
		expect(document.addEventListener).toHaveBeenCalledWith(
			"click",
			expect.any(Function),
		);
	});
	it.each([
		{ doNotTrack: "1" },
		{ globalPrivacyControl: true },
	])("respects browser privacy signal %j", async (signal) => {
		vi.stubGlobal("navigator", signal);
		await import("./instrumentation-client");
		expect(sdk.init).not.toHaveBeenCalled();
	});
	it("does not collect developer traffic", async () => {
		vi.stubEnv("NODE_ENV", "development");
		await import("./instrumentation-client");
		expect(sdk.init).not.toHaveBeenCalled();
	});
	it("stays disabled when no public project key is configured", async () => {
		vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "");
		await import("./instrumentation-client");
		expect(sdk.init).not.toHaveBeenCalled();
	});
});
