import { expect, test, vi } from "vitest";

const open = vi.hoisted(() => vi.fn());
vi.mock("../../src/lib/platform-capabilities.ts", () => ({
	openExternal: open,
}));

import { isHttpUrl, openHttpLink } from "../../src/lib/http-links.ts";

test("provider links accept HTTP(S) only and reject protocol handlers before opening", async () => {
	open.mockClear();
	for (const url of [
		"javascript:alert(1)",
		"file:///etc/passwd",
		"vscode://file/a",
		"data:text/html,test",
		"//github.com/a",
		"invalid",
	]) {
		expect(isHttpUrl(url)).toBe(false);
		await openHttpLink(url);
	}
	expect(open).not.toHaveBeenCalled();
	for (const url of [
		"https://github.com/acme/app/actions/runs/1",
		"http://ci.example.com/job/1",
	]) {
		expect(isHttpUrl(url)).toBe(true);
		await openHttpLink(url);
	}
	expect(open).toHaveBeenCalledTimes(2);
});
