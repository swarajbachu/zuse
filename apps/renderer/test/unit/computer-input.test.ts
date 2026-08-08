import { describe, expect, it } from "vitest";

import { parseComputerInput } from "../../src/lib/computer-input.ts";

const DEEP_LINK = `zuse:///connect/pair?pairingUrl=${encodeURIComponent(
	"wss://box.tail1234.ts.net/rpc",
)}#token=zp_abc123`;

describe("parseComputerInput", () => {
	it("returns empty for blank input", () => {
		expect(parseComputerInput("")).toEqual({ kind: "empty" });
		expect(parseComputerInput("   ")).toEqual({ kind: "empty" });
	});

	it("accepts a deep connect link and classifies its transport", () => {
		const parsed = parseComputerInput(DEEP_LINK);
		expect(parsed).toEqual({
			kind: "link",
			link: DEEP_LINK,
			linkKind: "tailscale",
		});
	});

	it("rewrites a copied browser link into the frozen deep-link form", () => {
		const parsed = parseComputerInput(
			"https://box.tail1234.ts.net/#pair=zp_abc123",
		);
		expect(parsed.kind).toBe("link");
		if (parsed.kind !== "link") return;
		expect(parsed.linkKind).toBe("tailscale");
		const url = new URL(parsed.link);
		expect(url.protocol).toBe("zuse:");
		expect(url.searchParams.get("pairingUrl")).toBe(
			"wss://box.tail1234.ts.net/rpc",
		);
		expect(url.hash).toBe("#token=zp_abc123");
	});

	it("keeps the pairing code intact when the browser link URL-encoded it", () => {
		const parsed = parseComputerInput(
			`https://host.example.com/#pair=${encodeURIComponent("zp_a+b/c")}`,
		);
		expect(parsed.kind).toBe("link");
		if (parsed.kind !== "link") return;
		expect(new URL(parsed.link).hash).toBe("#token=zp_a+b/c");
	});

	it("rejects links that are not Zuse connect links", () => {
		expect(parseComputerInput("https://example.com/some/page").kind).toBe(
			"invalid",
		);
		expect(parseComputerInput("http://box.local/#pair=zp_x").kind).toBe(
			"invalid",
		);
	});

	it("parses user@host:port as an SSH target", () => {
		expect(parseComputerInput("deploy@gpu-box.internal:2202")).toEqual({
			kind: "ssh",
			target: {
				alias: "gpu-box.internal",
				hostname: "gpu-box.internal",
				username: "deploy",
				port: 2202,
			},
		});
	});

	it("parses a bare host and an ssh-prefixed form", () => {
		expect(parseComputerInput("build-box")).toEqual({
			kind: "ssh",
			target: {
				alias: "build-box",
				hostname: "build-box",
				username: null,
				port: null,
			},
		});
		expect(parseComputerInput("ssh deploy@build-box")).toMatchObject({
			kind: "ssh",
			target: { hostname: "build-box", username: "deploy" },
		});
	});

	it("rejects out-of-range ports and unparseable addresses", () => {
		expect(parseComputerInput("host:70000").kind).toBe("invalid");
		expect(parseComputerInput("not a host name").kind).toBe("invalid");
	});
});
