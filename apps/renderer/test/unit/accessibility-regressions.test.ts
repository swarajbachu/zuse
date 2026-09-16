import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import chatViewSource from "../../src/components/chat-view.tsx?raw";
import environmentSummarySource from "../../src/components/environment-summary.tsx?raw";
import permissionCardSource from "../../src/components/permission-card.tsx?raw";
import projectsSidebarSource from "../../src/components/projects-sidebar.tsx?raw";
import questionCardSource from "../../src/components/question-card.tsx?raw";
import rightPaneSource from "../../src/components/right-pane.tsx?raw";
import topBarSource from "../../src/components/top-bar.tsx?raw";
import composerSource from "../../src/lib/codemirror/composer.ts?raw";

const stylesSource = readFileSync(
	new URL("../../src/styles.css", import.meta.url),
	"utf8",
);

const sourceBetween = (source: string, start: string, end: string): string => {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex);
	expect(startIndex).toBeGreaterThanOrEqual(0);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
};

const hslVariable = (
	scope: string,
	variable: string,
): readonly [number, number, number] => {
	const match = scope.match(
		new RegExp(
			`--${variable}:\\s*hsl\\(([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%\\)`,
		),
	);
	expect(match, `missing --${variable}`).not.toBeNull();
	return [Number(match?.[1]), Number(match?.[2]), Number(match?.[3])];
};

const hslToRgb = (
	hue: number,
	saturationPercent: number,
	lightnessPercent: number,
): readonly [number, number, number] => {
	const saturation = saturationPercent / 100;
	const lightness = lightnessPercent / 100;
	const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
	const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
	const offset = lightness - chroma / 2;
	const [red, green, blue] =
		hue < 60
			? [chroma, second, 0]
			: hue < 120
				? [second, chroma, 0]
				: hue < 180
					? [0, chroma, second]
					: hue < 240
						? [0, second, chroma]
						: hue < 300
							? [second, 0, chroma]
							: [chroma, 0, second];
	return [red + offset, green + offset, blue + offset];
};

const linearChannel = (channel: number): number =>
	channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const luminance = (color: readonly [number, number, number]): number =>
	linearChannel(color[0]) * 0.2126 +
	linearChannel(color[1]) * 0.7152 +
	linearChannel(color[2]) * 0.0722;

const contrastRatio = (
	foreground: readonly [number, number, number],
	background: readonly [number, number, number],
): number => {
	const values = [luminance(foreground), luminance(background)].sort(
		(a, b) => b - a,
	);
	return ((values[0] ?? 0) + 0.05) / ((values[1] ?? 0) + 0.05);
};

describe("renderer accessibility regressions", () => {
	it("gives the CodeMirror message textbox a stable accessible name", () => {
		expect(composerSource).toMatch(
			/EditorView\.contentAttributes\.of\(\{\s*"aria-label":\s*"Message composer"/,
		);
	});

	it("keeps the project toggle separate from its sibling actions", () => {
		const projectHeader = sourceBetween(
			projectsSidebarSource,
			"Project header toggles expansion only.",
			"<ProjectContextMenu",
		);
		expect(projectHeader).not.toContain('role="button"');
		expect(projectHeader).not.toContain("tabIndex={0}");
		expect(projectHeader).toContain("aria-expanded={isExpanded}");
		expect(projectHeader.indexOf("</button>")).toBeLessThan(
			projectHeader.indexOf("<NewChatButton"),
		);
	});

	it("keeps the chat selector separate from its archive action", () => {
		const chatRow = sourceBetween(
			projectsSidebarSource,
			"function ChatRow",
			"function ChatAttentionIcon",
		);
		expect(chatRow).not.toContain('role="button"');
		expect(chatRow).not.toContain("tabIndex={0}");
		expect(chatRow).toContain("onClick={() => selectChat(chat.id)}");
		expect(chatRow).toContain("onContextMenu={onContextMenu}");
		expect(chatRow.indexOf("</button>")).toBeLessThan(
			chatRow.indexOf("aria-label={"),
		);
	});

	it("gives every selected chat state one canonical page heading", () => {
		expect(chatViewSource.match(/<h1/g)).toHaveLength(1);
		expect(chatViewSource).toContain('<h1 className="sr-only">');
		expect(chatViewSource).toContain(
			'{session.title || uiMessage("chat:chat_view_new_chat")}',
		);
		expect(chatViewSource.indexOf("<h1")).toBeLessThan(
			chatViewSource.indexOf("{messages.length === 0 ? ("),
		);
	});

	it("uses uniquely named toolbars instead of duplicate banner landmarks", () => {
		expect(topBarSource).not.toContain("<header");
		for (const label of [
			"projects_toolbar",
			"workspace_toolbar",
			"workflow_toolbar",
		]) {
			expect(topBarSource).toContain(
				`aria-label={uiMessage("common:${label}")}`,
			);
		}
	});

	it("contains only the top-level edge toolbars in named regions", () => {
		const projectsToolbar = sourceBetween(
			topBarSource,
			"export function TopBarLeft",
			"export function TopBarMain",
		);
		expect(projectsToolbar).toMatch(
			/<section\s+aria-label=\{uiMessage\("common:projects_controls"\)\}/,
		);

		const workspaceToolbar = sourceBetween(
			topBarSource,
			"export function TopBarMain",
			"export function BranchMenuButton",
		);
		expect(workspaceToolbar).not.toContain("<section");

		const workflowToolbar = sourceBetween(
			topBarSource,
			"export function TopBarRight",
			"export function TopBarRightContent",
		);
		expect(workflowToolbar).toMatch(
			/<section\s+aria-label=\{uiMessage\("common:workflow_controls"\)\}/,
		);
	});

	it("gives every complementary pane a unique accessible name", () => {
		const projectsSidebar = sourceBetween(
			projectsSidebarSource,
			"export function ProjectsSidebar",
			"function SidebarActions",
		);
		expect(projectsSidebar).toContain(
			'aria-label={uiMessage("common:projects_and_chats")}',
		);

		expect(rightPaneSource.match(/<aside/g)).toHaveLength(2);
		expect(
			rightPaneSource.match(
				/aria-label=\{uiMessage\("chat:workspace_panels"\)\}/g,
			),
		).toHaveLength(2);
	});

	it("uses readable semantic text colors for compact sidebar metadata", () => {
		const actionRow = sourceBetween(
			projectsSidebarSource,
			"function SidebarActionRow",
			"function SidebarFooter",
		);
		expect(actionRow).not.toContain("text-muted-foreground/60");
		expect(projectsSidebarSource).toContain('className="text-danger-text"');
		expect(environmentSummarySource).toContain('className="text-danger-text"');
		expect(questionCardSource).toContain("text-xs text-danger-text");
		expect(permissionCardSource).toContain("text-xs text-danger-text");

		const lightTheme = sourceBetween(stylesSource, ":root {", ".dark {");
		const darkTheme = stylesSource.slice(stylesSource.indexOf(".dark {"));
		for (const theme of [lightTheme, darkTheme]) {
			const dangerText = hslToRgb(...hslVariable(theme, "danger-text"));
			for (const surface of ["card", "sidebar"] as const) {
				expect(
					contrastRatio(dangerText, hslToRgb(...hslVariable(theme, surface))),
					`--danger-text against --${surface}`,
				).toBeGreaterThanOrEqual(4.5);
			}
		}
	});
});
