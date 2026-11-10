import { describe, expect, it, vi } from "vitest";

const platform = vi.hoisted(() => ({ OS: "android" }));

vi.mock("react-native", () => ({
	Platform: platform,
	Dimensions: { get: () => ({ width: 0, height: 0 }) },
	useWindowDimensions: () => ({ width: 0, height: 0 }),
}));

vi.mock("~/theme", () => ({ colors: { bg: "#f7f7f5" } }));

const { isTabletSize, shouldLockPortrait } = await import(
	"../../../src/lib/form-factor"
);

describe("form factor", () => {
	it.each([
		[{ width: 412, height: 915 }, false],
		[{ width: 915, height: 412 }, false],
		[{ width: 800, height: 1280 }, true],
		[{ width: 1280, height: 800 }, true],
		[{ width: 600, height: 960 }, true],
	])("classifies %o", (size, tablet) => {
		expect(isTabletSize(size)).toBe(tablet);
	});
});

describe("rotation policy", () => {
	it.each([
		["ios", { width: 466, height: 678 }, false],
		["ios", { width: 678, height: 466 }, false],
		["ios", { width: 669, height: 951 }, false],
		["ios", { width: 1032, height: 1376 }, false],
		["android", { width: 412, height: 915 }, true],
		["android", { width: 800, height: 1280 }, false],
	])("%s at %o locks portrait: %s", (os, size, locked) => {
		platform.OS = os;
		expect(shouldLockPortrait(size)).toBe(locked);
	});
});
