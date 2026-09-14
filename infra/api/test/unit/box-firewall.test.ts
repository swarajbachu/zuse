import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(
	new URL("../../../cloud-sandboxes/box/zuse-firewall", import.meta.url),
	"utf8",
);
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell dispatch marker
const functions = script.slice(0, script.indexOf('case "${1:-}" in'));
const rules = (allow: string, deny = "") =>
	execFileSync(
		"bash",
		[
			"-c",
			functions +
				'\nzuse_uid() { echo 1001; }\ngetent() { echo "203.0.113.5 STREAM example.test"; }\nruleset_restricted "$1" "$2"',
			"firewall-test",
			allow,
			deny,
		],
		{ encoding: "utf8" },
	);

describe("Box restricted firewall", () => {
	it("emits IPv4, IPv6 and resolved-host rules without an unrestricted DNS exception", () => {
		const policy = rules("192.0.2.0/24\n2001:db8::/32\n::1\nexample.test");
		expect(policy).toContain("ip daddr 192.0.2.0/24 accept");
		expect(policy).toContain("ip6 daddr 2001:db8::/32 accept");
		expect(policy).toContain("ip6 daddr ::1 accept");
		expect(policy).toContain("ip daddr 203.0.113.5 accept");
		expect(policy).not.toContain("dport 53 accept");
		expect(policy).toContain("meta skuid 1001 drop");
	});
	it("applies explicit denials before grants", () => {
		const policy = rules("192.0.2.0/24", "192.0.2.3");
		expect(policy.indexOf("ip daddr 192.0.2.3 drop")).toBeLessThan(
			policy.indexOf("ip daddr 192.0.2.0/24 accept"),
		);
	});
	it("rejects malformed entries rather than emitting injected nft statements", () => {
		expect(() => rules("host; accept")).toThrow();
	});
});
