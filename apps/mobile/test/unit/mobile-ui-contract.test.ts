import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const appFile = (relativePath: string): string =>
	readFileSync(`${process.cwd()}/app/${relativePath}`, "utf8");

describe("mobile UI contracts", () => {
	test("keeps light surfaces light and uses one neon accent in both themes", () => {
		const css = readFileSync(`${process.cwd()}/global.css`, "utf8");
		expect(css).toContain("@media (prefers-color-scheme: light)");
		expect(css).toContain("--app-background: #ffffff");
		expect(css.match(/--app-primary: #c8ff00/g)).toHaveLength(3);
		expect(css).not.toContain("#34c759");
	});

	test("presents settings as a system-backed native form sheet", () => {
		const layout = appFile("_layout.tsx");
		expect(layout).toContain('name="settings"');
		expect(layout).toContain('presentation: "formSheet"');
		expect(layout).toContain("sheetAllowedDetents: [0.7, 0.92]");
		expect(layout).toContain("contentStyle: { backgroundColor: colors.bg }");
	});

	test("reuses the model sheet from new chat", () => {
		const newChat = appFile("new-chat.tsx");
		expect(newChat).toContain("<ModelSheetTrigger");
		expect(newChat).toContain("<ModelSheet");
		expect(newChat).not.toContain("<ComposerModelMenu");
	});

	test("keeps the camera preview active and explicitly full screen", () => {
		const scanner = appFile("connect/scan.tsx");
		expect(scanner).toContain("<CameraView");
		expect(scanner).toContain("active");
		expect(scanner).toContain("style={StyleSheet.absoluteFill}");
	});

	test("floats the composer over the feed and centers the jump control", () => {
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		expect(thread).toContain("paddingBottom: bottomAccessoryHeight + 12");
		expect(thread).toContain(
			'position: "absolute", left: 0, right: 0, bottom: 0',
		);
		expect(thread).toContain(
			'behavior={process.env.EXPO_OS === "ios" ? "position" : "height"}',
		);
		expect(thread).toContain('tint="systemUltraThinMaterial"');
		expect(thread).toContain('alignItems: "center"');
	});
});
