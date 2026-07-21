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
		expect(newChat).toContain("<ComposerModeChip");
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
		const approvalMenu = readFileSync(
			`${process.cwd()}/src/components/composer-approval-menu.ios.tsx`,
			"utf8",
		);
		expect(plusMenu).toContain('label="Choose photos"');
		expect(plusMenu).toContain('label="Choose files"');
		expect(plusMenu).toContain('label="Add goal"');
		expect(plusMenu).toContain('label="Plan mode"');
		for (const source of [plusMenu, approvalMenu]) {
			expect(source).toContain('ignoreSafeArea="keyboard"');
			expect(source).toContain("style={{ width: 40, height: 40 }}");
			expect(source).not.toContain("<Host matchContents");
		}
	});

	test("keeps attachments and unboxed mode state inside both composers", () => {
		const newChat = appFile("new-chat.tsx");
		const threadComposer = readFileSync(
			`${process.cwd()}/src/components/composer.tsx`,
			"utf8",
		);
		const modeChip = readFileSync(
			`${process.cwd()}/src/components/composer-mode-chip.tsx`,
			"utf8",
		);
		for (const source of [newChat, threadComposer]) {
			expect(source).toContain("<ComposerAttachmentStrip");
			expect(source).toContain("<ComposerInputFrame");
			expect(source).toContain("<ComposerModeChip");
			expect(source).toContain("<ComposerPlusMenu");
		}
		expect(modeChip).toContain("plan ? colors.accent : colors.fg");
		for (const source of [newChat, threadComposer]) {
			expect(source).toContain("<ComposerApprovalMenu");
			expect(source).toContain("<ModelSheetTrigger");
		}
		expect(threadComposer).not.toContain("fileCount > 0");
		expect(threadComposer).not.toContain("fileItemId");
	});

	test("keeps selected modes visible without forcing the composer active", () => {
		const threadComposer = readFileSync(
			`${process.cwd()}/src/components/composer.tsx`,
			"utf8",
		);
		const expandedPolicy = threadComposer.slice(
			threadComposer.indexOf("const expanded ="),
			threadComposer.indexOf("const agentCount"),
		);

		expect(expandedPolicy).not.toContain("goalMode");
		expect(expandedPolicy).not.toContain("planMode");
		expect(threadComposer.match(/<ComposerModeChip/g)).toHaveLength(4);
	});

	test("keeps the camera preview active and explicitly full screen", () => {
		const scanner = appFile("connect/scan.tsx");
		expect(scanner).toContain("<CameraView");
		expect(scanner).toContain("active");
		expect(scanner).toContain("style={StyleSheet.absoluteFill}");
	});

	test("floats the composer over the feed and centers the jump control", () => {
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		expect(thread).toContain("useHeaderHeight");
		expect(thread).toContain("paddingTop: headerHeight + 12");
		expect(thread).toContain("height: transcriptFooterHeight");
		expect(thread).toContain('contentInsetAdjustmentBehavior="never"');
		expect(thread).toContain("transcriptBottomInset(");
		expect(thread).toContain("onScrollBeginDrag={detachReader}");
		expect(thread).toContain("onMessageSubmitted={onMessageSubmitted}");
		expect(thread).toContain("bottom: keyboardOverlap");
		expect(thread).toContain(
			"bottom: keyboardOverlap + bottomAccessoryHeight + 8",
		);
		expect(thread).toContain('"keyboardWillChangeFrame"');
		expect(thread).not.toContain("<KeyboardAvoidingView");
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

	test("opens and populates threads from canonical session data", () => {
		const layout = appFile("_layout.tsx");
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		const threads = appFile("c/[conn]/chat/[chatId]/threads.tsx");
		expect(layout).toContain("sheetAllowedDetents: [0.42, 0.92]");
		expect(layout).toContain("sheetInitialDetentIndex: 0");
		expect(thread).toContain("const chatId = detail?.session.chatId ?? null");
		expect(threads).toContain("bundles.flatMap((bundle) => bundle.sessions)");
		expect(threads).toContain(
			"orderedChatSessions(allConnectionSessions, normalizedChatId)",
		);
		expect(threads).toContain("normalizedChatId,");
		expect(threads).toContain('style={{ width: "100%", height: "100%" }}');
		expect(threads).not.toContain("sheetContentHeight");
		expect(threads).not.toContain('className="flex-1 bg-background"');
	});

	test("anchors latest-turn navigation without bottom-scroll races", () => {
		const thread = appFile("c/[conn]/session/[sessionId].tsx");
		expect(thread).toContain("scrollToLatestTurn");
		expect(thread).toContain("latestTurnTopOffset");
		expect(thread).not.toContain("scrollToEnd");
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
		const inlineFileDiff = readFileSync(
			`${process.cwd()}/src/components/diff/inline-file-diff.tsx`,
			"utf8",
		);
		const reviewPill = readFileSync(
			`${process.cwd()}/src/components/review-changes-pill.tsx`,
			"utf8",
		);
		const sessionActions = readFileSync(
			`${process.cwd()}/src/components/session-actions-menu.ios.tsx`,
			"utf8",
		);
		expect(layout).toContain('name="c/[conn]/session/[sessionId]/files"');
		expect(layout).toContain('name="c/[conn]/session/[sessionId]/review"');
		expect(layout).toContain('presentation: "formSheet"');
		expect(thread).toContain("onFiles={openFiles}");
		expect(thread).toContain("onChanges={openChanges}");
		expect(thread).toContain("<ThreadHeaderTitle");
		expect(thread).toContain("headerTitle: () => (");
		expect(thread).toContain("headerRight: () => (");
		expect(sessionActions).toContain("<Menu");
		expect(sessionActions).toContain("<NativeButton");
		expect(sessionActions).not.toContain("ActionSheetIOS");
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
		expect(review).toContain('"arrow.up.left.and.arrow.down.right"');
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
		expect(file).not.toContain("useHeaderHeight");
		expect(file).toContain('contentInsetAdjustmentBehavior="automatic"');
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
		expect(diffList).toContain("accordionKey");
		expect(diffList).toContain("allFilesExpanded");
		expect(syntax).toContain("MAX_HIGHLIGHT_CACHE_ENTRIES");
		expect(syntax).toContain("MAX_HIGHLIGHT_CHARS");
		expect(turn).toContain("<FileIcon");
		expect(turn).toContain("setExpandedFile");
		expect(turn).toContain("<InlineFileDiff");
		expect(inlineFileDiff).toContain("<DiffCodeRow");
		expect(turn).toContain(
			"workspaceDisplayPath(file.path, context.workspaceRoot)",
		);
		expect(turn).toContain("gap-2 px-3");
		expect(turn).not.toContain("/tool/[itemId]");
		expect(thread).toContain("workspaceRoot: detail?.project.path");
		const messageRow = readFileSync(
			`${process.cwd()}/src/components/messages/message-row.tsx`,
			"utf8",
		);
		expect(messageRow).toContain(
			"workspaceDisplayPath(change.path, workspaceRoot)",
		);
		expect(messageRow).toContain(
			"<InlineFileDiff lines={change.lines} lineLimit={80} />",
		);
		expect(messageRow).toContain("<FileIcon path={change.path} size={16} />");
		expect(messageRow).toContain("accessibilityState={{ expanded }}");
		expect(messageRow).toContain("color: colors.accent");
		expect(messageRow).not.toContain("stats={view.fileChangeTotals}");
		expect(sessionActions).toContain("<Host");
		expect(sessionActions).toContain("<Menu");
		expect(sessionActions).toContain("color={colors.fg}");
		expect(sessionActions).toContain('role="destructive"');
		expect(sessionActions).not.toContain("NEON_GREEN");
		expect(reviewPill).not.toContain("GitCompareArrows");
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
