import "@zuse/i18n/english/commands";
import type { Command } from "@zuse/contracts";
import { useMessages } from "@zuse/i18n/react";

import {
	Dialog,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "~/components/ui/dialog";
import { Kbd } from "~/components/ui/kbd";
import { COMMAND_META } from "~/lib/default-keybindings";
import { useKeybindings } from "~/lib/keybindings-client-bus";
import { formatShortcut } from "~/lib/shortcuts";
import { useShortcutsPanel } from "~/store/shortcuts-panel";
import { useUiStore } from "~/store/ui";

const COMPOSER_COMMANDS: readonly Command[] = [
	"composer.submit",
	"composer.newline",
	"composer.forceSubmit",
	"composer.queueSubmit",
	"composer.interrupt",
	"composer.previousMessage",
	"composer.searchHistory",
	"composer.stash",
	"composer.togglePlanMode",
	"composer.deleteToStart",
	"composer.deleteToEnd",
	"composer.yank",
];

const CHAT_COMMANDS: readonly Command[] = [
	"open-model-picker",
	"cycle-reasoning-effort",
	"toggle-fast-mode",
	"toggle-tool-details",
	"toggle-task-list",
	"find-in-chat",
	"stop-background-tasks",
];

const APP_COMMANDS: readonly Command[] = [
	"new-chat",
	"open-chat-switcher",
	"search-files",
	"focus-composer",
	"toggle-left-sidebar",
	"toggle-terminal",
	"show-shortcuts",
];

const TRIGGERS = [
	{ key: "/", labelKey: "commands:shortcuts_panel_trigger_command" },
	{ key: "@", labelKey: "commands:shortcuts_panel_trigger_file" },
	{ key: "$", labelKey: "commands:shortcuts_panel_trigger_skill" },
	{ key: ":", labelKey: "commands:shortcuts_panel_trigger_emoji" },
] as const;

function ShortcutRow({
	label,
	keys,
}: {
	readonly label: string;
	readonly keys: string;
}) {
	return (
		<div className="flex h-7 items-center justify-between gap-3 text-xs">
			<span className="min-w-0 truncate text-foreground">{label}</span>
			<Kbd className="shrink-0 px-1.5">{keys}</Kbd>
		</div>
	);
}

function Section({
	title,
	children,
}: {
	readonly title: string;
	readonly children: React.ReactNode;
}) {
	return (
		<section className="min-w-0">
			<h3 className="mb-1 text-[11px] font-medium text-muted-foreground">
				{title}
			</h3>
			{children}
		</section>
	);
}

/**
 * Cheat sheet of the shortcuts in effect right now. Bindings come from the
 * live keybindings, so rebinding in Settings is reflected here.
 */
export function ShortcutsPanel() {
	const { message } = useMessages(["commands"]);
	const open = useShortcutsPanel((s) => s.open);
	const setOpen = useShortcutsPanel((s) => s.setOpen);
	useKeybindings((s) => s.resolvedRules);

	const rows = (commands: readonly Command[]) =>
		commands.flatMap((command) => {
			const keys = formatShortcut(command);
			return keys.length === 0
				? []
				: [
						<ShortcutRow
							key={command}
							label={COMMAND_META[command].label}
							keys={keys}
						/>,
					];
		});

	const openSettings = () => {
		setOpen(false);
		const ui = useUiStore.getState();
		ui.setView("settings");
		ui.setSettingsSection({ kind: "shortcuts" });
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogPopup className="max-w-2xl">
				<DialogHeader>
					<DialogTitle>{message("commands:shortcuts_panel_title")}</DialogTitle>
					<DialogDescription>
						{message("commands:shortcuts_panel_description")}
					</DialogDescription>
				</DialogHeader>
				<DialogPanel className="grid grid-cols-1 gap-x-8 gap-y-4 overflow-y-auto sm:grid-cols-2">
					<div className="flex min-w-0 flex-col gap-4">
						<Section title={message("commands:command_group_composer")}>
							{rows(COMPOSER_COMMANDS)}
						</Section>
						<Section title={message("commands:shortcuts_panel_triggers")}>
							{TRIGGERS.map((trigger) => (
								<ShortcutRow
									key={trigger.key}
									label={message(trigger.labelKey)}
									keys={trigger.key}
								/>
							))}
						</Section>
					</div>
					<div className="flex min-w-0 flex-col gap-4">
						<Section title={message("commands:shortcuts_panel_chat")}>
							{rows(CHAT_COMMANDS)}
						</Section>
						<Section title={message("commands:command_group_application")}>
							{rows(APP_COMMANDS)}
						</Section>
					</div>
				</DialogPanel>
				<DialogFooter>
					<button
						type="button"
						onClick={openSettings}
						className="inline-flex h-7 items-center rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
					>
						{message("commands:shortcuts_panel_customize")}
					</button>
				</DialogFooter>
			</DialogPopup>
		</Dialog>
	);
}
