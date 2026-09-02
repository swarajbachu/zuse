/// <reference types="node" />

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rendererSource = (path: string): string =>
	readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");

describe("renderer design system", () => {
	it("defines the green-neutral ladder in both themes", () => {
		const styles = rendererSource("styles.css");

		for (const token of [
			"--background: hsl(90 20% 97%)",
			"--foreground: hsl(132 14% 13%)",
			"--border: hsl(110 13% 89%)",
			"--background: hsl(140 5% 4.5%)",
			"--card: hsl(136 5% 7.5%)",
			"--popover: hsl(132 5% 10.5%)",
		]) {
			expect(styles).toContain(token);
		}
	});

	it("uses Geist and keeps lime as the shared focus and primary color", () => {
		const styles = rendererSource("styles.css");

		expect(styles).toContain('@import "@fontsource-variable/geist"');
		expect(styles).not.toContain('@import "@fontsource-variable/inter"');
		expect(styles).toContain("--primary: var(--lime)");
		expect(styles).toContain("--ring: var(--lime)");
		expect(styles).toContain("--lime: hsl(83 72% 46%)");
	});

	it("keeps compact settings actions at 28px", () => {
		const settings = rendererSource("components/ui/settings-panel.tsx");
		const buttons = rendererSource("components/ui/button.tsx");

		expect(settings).toContain('className="flex h-7 shrink-0 items-center"');
		expect(buttons).toContain('default: "h-7');
		expect(buttons).toContain('settings:\n\t\t\t\t\t"h-7');
	});

	it("uses one calm settings width and shared frames for core panes", () => {
		const settings = rendererSource("components/settings-page.tsx");

		expect(settings).toContain(': "max-w-3xl"');
		expect(settings).toContain('title="Chat defaults"');
		expect(settings).toContain('title="Agent providers"');
		expect(settings).not.toContain('visibleSection.kind === "providers" ||');
		expect(settings).not.toContain('visibleSection.kind === "defaults"');
	});

	it("gives text buttons deliberate horizontal spacing", () => {
		const buttons = rendererSource("components/ui/button.tsx");

		expect(buttons).toContain('default: "h-7 px-[calc(--spacing(4)-1px)]"');
		expect(buttons).toContain(
			'sm: "h-6 gap-1 px-[calc(--spacing(3.5)-1px)] text-[11px]"',
		);
		expect(buttons).toContain("bg-card px-4 text-xs text-foreground");
	});

	it("keeps overlays compact and removes decorative provider gradients", () => {
		const popover = rendererSource("components/ui/popover.tsx");
		const composer = rendererSource("components/chat-composer.tsx");
		const provider = rendererSource("components/provider-card.tsx");

		expect(popover).toContain("rounded-lg bg-glass");
		expect(popover).not.toContain("rounded-2xl");
		expect(composer).not.toContain("bg-gradient-to-r from-rose");
		expect(provider).not.toContain("violet-");
	});

	it("keeps composer controls direct and landing menus bounded", () => {
		const composer = rendererSource("components/chat-composer.tsx");
		const landing = rendererSource("components/chat-landing.tsx");
		const modelPicker = rendererSource("components/model-picker.tsx");
		const trays = rendererSource("components/composer/tray-pill.tsx");

		expect(composer).toContain("<RuntimeAccessPicker");
		expect(composer).toContain("Agent access");
		expect(composer).toContain("mx-auto flex min-h-8 w-14/15");
		expect(composer).toContain("rounded-b-none rounded-t-[1.2rem]");
		expect(composer).toContain("composer-glass rounded-[1.2rem]");
		expect(composer).not.toContain("<FrameFooter");
		expect(composer).toContain("<ComposerModelPicker");
		expect(composer).not.toContain("<ReasoningPicker");
		expect(composer).toContain("triggerDetail={activeLabel}");
		expect(composer).toContain('metalFx={level === "ultra"}');
		expect(composer).toContain("reflectionTargets={ultraReflectionTargets}");
		expect(composer).toContain("<Slider");
		expect(composer).toContain("aria-valuetext={activeLabel}");
		expect(modelPicker).toContain('label.replace(/^gpt[-\\s]*/i, "")');
		expect(modelPicker).toContain("<ProviderIcon providerId={providerId}");
		expect(modelPicker).toContain("flex h-7 w-40 max-w-[40vw] items-center");
		expect(modelPicker).toContain("{optionsPanel}");
		expect(modelPicker).toContain('<MetalFx\n\t\t\t\t\tpreset="silver"');
		expect(trays).toContain("composer-attached-rail mx-auto w-14/15");
		expect(composer).toContain(
			"flex min-w-0 flex-1 items-center gap-1 overflow-x-auto",
		);
		expect(landing).toContain(
			"flex min-h-0 flex-1 items-center justify-center pb-6",
		);
		expect(landing).toContain("flex shrink-0 flex-col gap-3");
		expect(landing).toContain('placeholder="Search projects…"');
		expect(landing).toContain("max-h-48 overflow-x-hidden overflow-y-auto");
		expect(landing).toContain("max-h-52 overflow-x-hidden overflow-y-auto");
	});

	it("uses 28px visible controls in browser authentication", () => {
		const accessGate = rendererSource("components/browser-access-gate.tsx");

		expect(accessGate).toContain(
			'className="h-7 min-w-0 flex-1 rounded-md border border-input',
		);
		expect(accessGate).not.toContain("min-h-11 rounded-lg bg-primary");
	});

	it("keeps the project rail quiet while giving every chat a rich hover state", () => {
		const sidebar = rendererSource("components/projects-sidebar.tsx");
		const landing = rendererSource("components/chat-landing.tsx");
		const computerPicker = rendererSource(
			"components/composer/computer-picker.tsx",
		);
		const cloudIcon = rendererSource("components/dither-cloud-icon.tsx");

		expect(sidebar).toContain("group-hover:opacity-100");
		expect(sidebar).toContain("group-focus-within:opacity-100");
		expect(sidebar).toContain("<SidebarProjectHoverCard");
		expect(sidebar.match(/<SidebarChatHoverCard/g)?.length).toBe(3);
		expect(sidebar).toContain("<DitherCloudIcon");
		expect(landing).toContain('role="menuitemradio"');
		expect(landing).toContain("<MenuSelectionIndicator");
		expect(computerPicker).toContain("<DitherCloudIcon");
		expect(cloudIcon).toContain('viewBox="0 0 40 40"');
		expect(cloudIcon).toContain('shapeRendering="crispEdges"');
		expect(cloudIcon).toContain('fill="currentColor"');
		expect(cloudIcon).not.toContain("opacity=");
	});
});
