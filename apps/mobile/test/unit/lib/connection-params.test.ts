import { expect, test } from "vitest";
import { optionsForConnection } from "../../../src/lib/connection-params";

test("unhydrated saved connection ids are not parsed as network addresses", () => {
	for (const source of ["paired", "api", "manual", "cloud", "relay"]) {
		expect(optionsForConnection(`${source}:env_example`, [])).toBeNull();
	}
	expect(optionsForConnection("192.168.1.10:8790", [])).toEqual({
		host: "192.168.1.10",
		port: 8790,
	});
});
