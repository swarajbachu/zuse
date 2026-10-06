import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	install: vi.fn(),
	openExternal: vi.fn(),
}));
vi.mock("../../src/lib/control-plane-client.ts", () => ({
	runCloudControl: (run: (client: unknown) => unknown) =>
		run({ "cloud.github.install": mocks.install }),
}));
vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	openExternal: mocks.openExternal,
}));

import { connectGithub } from "../../src/lib/connect-github.ts";

beforeEach(() => vi.resetAllMocks());

it("reserves the browser before requesting a workspace installation connection", async () => {
	const url = "https://api-staging.zuse.sh/v1/cloud/github/callback?state=test";
	mocks.install.mockResolvedValue({ url });
	mocks.openExternal.mockImplementation(
		async (resolve: () => Promise<string>) => {
			expect(mocks.install).not.toHaveBeenCalled();
			expect(await resolve()).toBe(url);
		},
	);
	await connectGithub();
	expect(mocks.install).toHaveBeenCalledOnce();
	expect(mocks.openExternal).toHaveBeenCalledOnce();
});

it("propagates connection failures so settings can show an error", async () => {
	mocks.install.mockRejectedValue(new Error("connection unavailable"));
	mocks.openExternal.mockImplementation((resolve: () => Promise<string>) =>
		resolve(),
	);
	await expect(connectGithub()).rejects.toThrow("connection unavailable");
});
