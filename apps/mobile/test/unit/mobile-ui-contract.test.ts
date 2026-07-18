import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const appFile = (relativePath: string): string =>
	readFileSync(`${process.cwd()}/app/${relativePath}`, "utf8");

describe("mobile UI contracts", () => {
	test("keeps light surfaces light and uses one neon accent in both themes", () => {
		const css = readFileSync(`${process.cwd()}/global.css`, "utf8");
		expect(css).toContain("@variant light");
		expect(css).toContain("@variant dark");
		expect(css).toContain("--color-background: #ffffff");
		expect(css).toContain("--color-background: hsl(72 5% 6%)");
		expect(css.match(/--color-primary: #c8ff00/g)).toHaveLength(2);
		expect(css).not.toContain("@media (prefers-color-scheme:");
		expect(css).not.toContain("#34c759");
	});

	test("uses the Uniwind theme as the single live appearance source", () => {
		const layout = appFile("_layout.tsx");
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		const appConfig = JSON.parse(
			readFileSync(`${process.cwd()}/app.json`, "utf8"),
		) as { expo: { userInterfaceStyle: string } };
		const nativeTheme = readFileSync(`${process.cwd()}/src/theme.ts`, "utf8");
		const glass = readFileSync(
			`${process.cwd()}/src/components/ui/glass-surface.tsx`,
			"utf8",
		);
		expect(appConfig.expo.userInterfaceStyle).toBe("automatic");
		expect(nativeTheme).toContain("Color.ios.systemBackground");
		expect(nativeTheme).toContain("Color.ios.label");
		for (const source of [layout, thread, glass]) {
			expect(source).toContain("useUniwind");
			expect(source).not.toContain("useColorScheme");
		}
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
		const modelSheet = readFileSync(
			`${process.cwd()}/src/components/model-sheet.ios.tsx`,
			"utf8",
		);
		expect(newChat).toContain("<ModelSheetTrigger");
		expect(newChat).toContain("<ModelSheet");
		expect(newChat).not.toContain("<ComposerModelMenu");
		expect(modelSheet).toContain("canChangeProvider && providers.length > 1");
		expect(modelSheet).not.toContain('label="Mode"');
		expect(modelSheet).toContain(
			"PROVIDER_NATIVE_ASSET_NAMES[value.providerId]",
		);
	});

	test("keeps plan and attachment actions directly on the composer plus menu", () => {
		const plusMenu = readFileSync(
			`${process.cwd()}/src/components/composer-plus-menu.ios.tsx`,
			"utf8",
		);
		expect(plusMenu).toContain('label="Choose photos"');
		expect(plusMenu).toContain('label="Choose files"');
		expect(plusMenu).toContain('label="Add goal"');
		expect(plusMenu).toContain('label="Plan mode"');
	});

	test("shows selected attachments and plan state inside both composers", () => {
		const newChat = appFile("new-chat.tsx");
		const threadComposer = readFileSync(
			`${process.cwd()}/src/components/composer.tsx`,
			"utf8",
		);
		for (const source of [newChat, threadComposer]) {
			expect(source).toContain("<ComposerAttachmentStrip");
			expect(source).toContain("<PlanPill");
			expect(source).toContain("<ComposerPlusMenu");
		}
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
		expect(thread).toContain("experimental_backgroundImage");
		expect(thread).not.toContain("BlurView");
		expect(thread).toContain('alignItems: "center"');
	});

	test("lets UIKit provide the native header material", () => {
		const layout = appFile("_layout.tsx");
		expect(layout).toContain("scrollEdgeEffects:");
		expect(layout).toContain('top: "automatic"');
		expect(layout).not.toContain("headerBlurEffect");
	});

	test("uses stack-based files and keeps file changes inline", () => {
		const layout = appFile("_layout.tsx");
		const files = appFile("c/[conn]/session/[sessionId]/files.tsx");
		const review = appFile("c/[conn]/session/[sessionId]/review.tsx");
		const tool = appFile("c/[conn]/session/[sessionId]/tool/[itemId].tsx");
		const file = appFile("c/[conn]/session/[sessionId]/file.tsx");
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		const diffList = readFileSync(
			`${process.cwd()}/src/components/diff/review-diff-list.tsx`,
			"utf8",
		);
		const turn = readFileSync(
			`${process.cwd()}/src/components/messages/turn-row.tsx`,
			"utf8",
		);
		const fileTabs = readFileSync(
			`${process.cwd()}/src/components/files/file-tabs.tsx`,
			"utf8",
		);
		const syntax = readFileSync(
			`${process.cwd()}/src/lib/syntax-highlighting.ts`,
			"utf8",
		);
		const nativeHeader = readFileSync(
			`${process.cwd()}/src/lib/native-header.ts`,
			"utf8",
		);
		const reviewPill = readFileSync(
			`${process.cwd()}/src/components/review-changes-pill.tsx`,
			"utf8",
		);
		expect(layout).toContain('name="c/[conn]/session/[sessionId]/files"');
		expect(layout).toContain('name="c/[conn]/session/[sessionId]/review"');
		expect(layout).toContain('presentation: "formSheet"');
		expect(thread).toContain("onFiles={openFiles}");
		expect(thread).toContain("onChanges={openChanges}");
		expect(thread).toContain("<ReviewChangesPill");
		expect(files).toContain('<Stack.Toolbar placement="bottom">');
		expect(files).toContain('placeholder="Search files"');
		expect(files).toContain("useHeaderHeight");
		expect(files).toContain("paddingTop: headerHeight");
		expect(files).not.toContain("headerTitle:");
		expect(files).toContain(
			"<Stack.Screen.Title>{projectName}</Stack.Screen.Title>",
		);
		expect(files).toContain("<FileTabs");
		expect(fileTabs).toContain("@expo/ui/community/segmented-control");
		expect(files).not.toContain("<ActivityIndicator");
		expect(files).toContain("<ReviewDiffList");
		expect(review).toContain("<ReviewDiffList");
		expect(review).toContain(
			"<Stack.Screen.Title>{reviewScopeLabel(scope)}</Stack.Screen.Title>",
		);
		expect(review).toContain('<Stack.Toolbar placement="left">');
		expect(review).toContain('<Stack.Toolbar placement="right">');
		expect(review).toContain("<Stack.Toolbar.Menu");
		expect(review).not.toContain("translucentNativeHeaderOptions");
		expect(review).toContain("collapsable={false}");
		expect(review).toContain("selectConnectionBundles");
		expect(review).not.toContain("bundlesByConnection[connKey] ?? []");
		expect(tool).toContain("<ReviewDiffList");
		expect(tool).toContain("<Stack.Screen.Title>");
		expect(tool).toContain('<Stack.Toolbar placement="left">');
		expect(tool).toContain('<Stack.Toolbar placement="right">');
		expect(tool).not.toContain("headerLeft:");
		expect(tool).not.toContain("headerTitle:");
		expect(tool).toContain("paddingTop: headerHeight");
		expect(review).toContain("paddingTop: headerHeight");
		expect(file).toContain("paddingTop: headerHeight");
		expect(file).toContain(
			"<Stack.Screen.Title>{basename(path)}</Stack.Screen.Title>",
		);
		expect(file).toContain("tokenizeCodeLine");
		expect(file).toContain("width: codeWidth");
		expect(diffList).toContain("<SectionList");
		expect(diffList).not.toContain("directionalLockEnabled");
		expect(diffList).not.toContain('ellipsizeMode="clip"');
		expect(diffList).toContain("min-h-6 flex-row items-stretch");
		expect(diffList).toContain('contentInsetAdjustmentBehavior="never"');
		expect(diffList).toContain("stickySectionHeadersEnabled={false}");
		expect(diffList).toContain("onViewableItemsChanged");
		expect(diffList).toContain("pinnedFileVisible");
		expect(diffList).toContain("patchRowsCache");
		expect(diffList).toContain("maintainVisibleContentPosition");
		expect(diffList).toContain("collapseAllKey");
		expect(syntax).toContain("MAX_HIGHLIGHT_CACHE_ENTRIES");
		expect(syntax).toContain("MAX_HIGHLIGHT_CHARS");
		expect(turn).toContain("<FileIcon");
		expect(turn).toContain("setExpandedFile");
		expect(turn).toContain("<DiffCodeRow");
		expect(turn).not.toContain("/tool/[itemId]");
		expect(reviewPill).not.toContain("GitCompareArrows");
		expect(nativeHeader).toContain(
			'headerBlurEffect: "systemUltraThinMaterial"',
		);
		expect(nativeHeader).toContain('backgroundColor: "transparent"');
		expect(files).not.toContain("translucentNativeHeaderOptions");
		expect(file).not.toContain("translucentNativeHeaderOptions");
	});

	test("puts an explicit retry action beside connection failures", () => {
		const home = appFile("index.tsx");
		const sessions = appFile("c/[conn]/index.tsx");
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		for (const source of [home, sessions, thread]) {
			expect(source).toContain("<ConnectionRecoveryBanner");
		}
		const scanner = appFile("connect/scan.tsx");
		expect(scanner).toContain("Try again");
	});
});
