import { expect, it } from "vitest";
import { theme } from "../index.client.ts";

const luminance = (hex: string) => {
	const channel = (offset: number) => {
		const s = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return channel(1) * 0.2126 + channel(3) * 0.7152 + channel(5) * 0.0722;
};
it("keeps body and accent text readable", () => {
	for (const [background, foreground] of [
		[theme.theme.colors.background, theme.theme.colors.foreground],
		[theme.theme.colors.accent, theme.theme.colors.accentForeground],
	] as const) {
		const a = luminance(background),
			b = luminance(foreground);
		expect(
			(Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
		).toBeGreaterThanOrEqual(4.5);
	}
	expect(theme.appearance).toBe("dark");
});
