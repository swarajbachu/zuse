import { describe, expect, it } from "vitest";

import { crumbsFor } from "../../src/components/environment-path-browser.tsx";

describe("environment path breadcrumbs", () => {
	it("builds navigable Unix breadcrumbs", () => {
		expect(crumbsFor("/home/user/Developer")).toEqual([
			{ label: "/", path: "/" },
			{ label: "home", path: "/home" },
			{ label: "user", path: "/home/user" },
			{ label: "Developer", path: "/home/user/Developer" },
		]);
	});

	it("builds navigable Windows breadcrumbs", () => {
		expect(crumbsFor("C:\\Users\\dev")).toEqual([
			{ label: "C:\\", path: "C:\\" },
			{ label: "Users", path: "C:\\Users" },
			{ label: "dev", path: "C:\\Users\\dev" },
		]);
	});
});
