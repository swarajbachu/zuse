import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllGlobals());

describe("download migration", () => {
	it.each([
		["", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
		["?platform=macos", "Mozilla/5.0 (Macintosh; ARM Mac OS X)"],
		["?platform=linux&format=deb", "Mozilla/5.0 (X11; Linux x86_64)"],
		["", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"],
		["", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"],
	])("opens the new release inventory for %s %s", async (query, userAgent) => {
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const response = await GET(
			new Request(`https://zuse.sh/download${query}`, {
				headers: { "user-agent": userAgent },
			}),
		);
		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://github.com/opcodehq/zuse/releases",
		);
		expect(fetch).not.toHaveBeenCalled();
	});
});
