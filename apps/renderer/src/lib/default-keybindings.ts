import "@zuse/i18n/english/commands";
import type { Command, KeybindingRule } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import { isMacHost } from "./host-platform.ts";

/** Control+letter clashes with the Ctrl-as-mod shortcuts on other platforms. */
const IS_MAC = isMacHost();

/**
 * Display metadata for each command. The label is shown in the settings
 * editor and any tooltips; `group` is the section header in the editor;
 * `description` is the sub-line under the label. Keep one entry per
 * member of the `Command` union — TypeScript enforces exhaustiveness.
 */
export interface CommandMeta {
	readonly label: string;
	readonly labelKey: import("@zuse/i18n").MessageKey;
	readonly description: string;
	readonly group: string;
}

export const COMMAND_META: Record<Command, CommandMeta> = {
	"new-chat-without-project": {
		labelKey: "commands:new_chat_without_project",
		get label() {
			return uiMessage("commands:new_chat_without_project");
		},
		get description() {
			return uiMessage("commands:new_chat_without_project_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"new-chat": {
		labelKey: "commands:default_keybindings_new_chat",
		get label() {
			return uiMessage("commands:default_keybindings_new_chat");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_start_a_new_session_in_the_selected_project",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"open-project": {
		labelKey: "commands:default_keybindings_open_project",
		get label() {
			return uiMessage("commands:default_keybindings_open_project");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_pick_a_folder_to_add_to_the_workspace",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	settings: {
		labelKey: "commands:default_keybindings_settings",
		get label() {
			return uiMessage("commands:default_keybindings_settings");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_open_or_close_the_settings_page",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"search-files": {
		labelKey: "commands:default_keybindings_search_files",
		get label() {
			return uiMessage("commands:default_keybindings_search_files");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_find_and_open_a_file_in_the_current_project_or_worktree",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"show-shortcuts": {
		labelKey: "commands:show_shortcuts",
		get label() {
			return uiMessage("commands:show_shortcuts");
		},
		get description() {
			return uiMessage("commands:show_shortcuts_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"find-in-chat": {
		labelKey: "commands:find_in_chat",
		get label() {
			return uiMessage("commands:find_in_chat");
		},
		get description() {
			return uiMessage("commands:find_in_chat_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"open-model-picker": {
		labelKey: "commands:open_model_picker",
		get label() {
			return uiMessage("commands:open_model_picker");
		},
		get description() {
			return uiMessage("commands:open_model_picker_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"cycle-reasoning-effort": {
		labelKey: "commands:cycle_reasoning_effort",
		get label() {
			return uiMessage("commands:cycle_reasoning_effort");
		},
		get description() {
			return uiMessage("commands:cycle_reasoning_effort_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"toggle-fast-mode": {
		labelKey: "commands:toggle_fast_mode",
		get label() {
			return uiMessage("commands:toggle_fast_mode");
		},
		get description() {
			return uiMessage("commands:toggle_fast_mode_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"toggle-tool-details": {
		labelKey: "commands:toggle_tool_details",
		get label() {
			return uiMessage("commands:toggle_tool_details");
		},
		get description() {
			return uiMessage("commands:toggle_tool_details_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"toggle-task-list": {
		labelKey: "commands:toggle_task_list",
		get label() {
			return uiMessage("commands:toggle_task_list");
		},
		get description() {
			return uiMessage("commands:toggle_task_list_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"stop-background-tasks": {
		labelKey: "commands:stop_background_tasks",
		get label() {
			return uiMessage("commands:stop_background_tasks");
		},
		get description() {
			return uiMessage("commands:stop_background_tasks_description");
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"close-tab": {
		labelKey: "commands:default_keybindings_close_tab",
		get label() {
			return uiMessage("commands:default_keybindings_close_tab");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_close_the_active_chat_tab",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"toggle-left-sidebar": {
		labelKey: "commands:default_keybindings_toggle_projects_panel",
		get label() {
			return uiMessage("commands:default_keybindings_toggle_projects_panel");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_show_or_hide_the_left_projects_sidebar",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"toggle-right-sidebar": {
		labelKey: "commands:default_keybindings_toggle_files_panel",
		get label() {
			return uiMessage("commands:default_keybindings_toggle_files_panel");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_show_or_hide_the_right_files_sidebar",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"toggle-terminal": {
		labelKey: "commands:default_keybindings_toggle_terminal",
		get label() {
			return uiMessage("commands:default_keybindings_toggle_terminal");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_open_the_right_pane_and_switch_to_the_terminal_tab",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"focus-composer": {
		labelKey: "commands:default_keybindings_focus_composer",
		get label() {
			return uiMessage("commands:default_keybindings_focus_composer");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_move_the_cursor_into_the_chat_input",
			);
		},
		get group() {
			return uiMessage("commands:command_group_application");
		},
	},
	"next-tab": {
		labelKey: "commands:default_keybindings_next_tab",
		get label() {
			return uiMessage("commands:default_keybindings_next_tab");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_to_the_next_tab_in_the_active_chat",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"prev-tab": {
		labelKey: "commands:default_keybindings_previous_tab",
		get label() {
			return uiMessage("commands:default_keybindings_previous_tab");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_to_the_previous_tab_in_the_active_chat",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-1": {
		labelKey: "commands:default_keybindings_go_to_tab_1",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_1");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_first_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-2": {
		labelKey: "commands:default_keybindings_go_to_tab_2",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_2");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_second_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-3": {
		labelKey: "commands:default_keybindings_go_to_tab_3",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_3");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_third_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-4": {
		labelKey: "commands:default_keybindings_go_to_tab_4",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_4");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_fourth_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-5": {
		labelKey: "commands:default_keybindings_go_to_tab_5",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_5");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_fifth_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-6": {
		labelKey: "commands:default_keybindings_go_to_tab_6",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_6");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_sixth_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-7": {
		labelKey: "commands:default_keybindings_go_to_tab_7",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_7");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_seventh_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-tab-8": {
		labelKey: "commands:default_keybindings_go_to_tab_8",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_tab_8");
		},
		get description() {
			return uiMessage("commands:default_keybindings_jump_to_the_eighth_tab");
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"select-last-tab": {
		labelKey: "commands:default_keybindings_go_to_last_tab",
		get label() {
			return uiMessage("commands:default_keybindings_go_to_last_tab");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_jump_to_the_last_tab_in_the_active_chat",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"new-tab": {
		labelKey: "commands:default_keybindings_new_tab",
		get label() {
			return uiMessage("commands:default_keybindings_new_tab");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_open_a_new_session_in_the_active_chat",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"next-chat": {
		labelKey: "commands:default_keybindings_next_chat",
		get label() {
			return uiMessage("commands:default_keybindings_next_chat");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_to_the_next_chat_in_the_sidebar",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"prev-chat": {
		labelKey: "commands:default_keybindings_previous_chat",
		get label() {
			return uiMessage("commands:default_keybindings_previous_chat");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_to_the_previous_chat_in_the_sidebar",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"next-panel": {
		labelKey: "commands:default_keybindings_next_panel",
		get label() {
			return uiMessage("commands:default_keybindings_next_panel");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_to_the_next_panel_in_the_right_pane",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"prev-panel": {
		labelKey: "commands:default_keybindings_previous_panel",
		get label() {
			return uiMessage("commands:default_keybindings_previous_panel");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_to_the_previous_panel_in_the_right_pane",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"focus-next-pane": {
		labelKey: "commands:default_keybindings_focus_next_pane",
		get label() {
			return uiMessage("commands:default_keybindings_focus_next_pane");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_move_keyboard_focus_to_the_next_region_sidebar_chat_composer_righ",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"focus-prev-pane": {
		labelKey: "commands:default_keybindings_focus_previous_pane",
		get label() {
			return uiMessage("commands:default_keybindings_focus_previous_pane");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_move_keyboard_focus_to_the_previous_region",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"open-chat-switcher": {
		labelKey: "commands:default_keybindings_switch_chat",
		get label() {
			return uiMessage("commands:default_keybindings_switch_chat");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_open_the_quick_switcher_to_jump_to_any_chat_in_any_project",
			);
		},
		get group() {
			return uiMessage("commands:command_group_navigation");
		},
	},
	"composer.submit": {
		labelKey: "commands:default_keybindings_submit_message",
		get label() {
			return uiMessage("commands:default_keybindings_submit_message");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_send_the_current_composer_contents",
			);
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.newline": {
		labelKey: "commands:default_keybindings_insert_newline",
		get label() {
			return uiMessage("commands:default_keybindings_insert_newline");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_add_a_line_break_instead_of_submitting",
			);
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.forceSubmit": {
		labelKey: "commands:default_keybindings_force_submit",
		get label() {
			return uiMessage("commands:default_keybindings_force_submit");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_submit_regardless_of_mention_skill_popover_state",
			);
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.previousMessage": {
		labelKey: "commands:composer_previousMessage",
		get label() {
			return uiMessage("commands:composer_previousMessage");
		},
		get description() {
			return uiMessage("commands:composer_previousMessage_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.nextMessage": {
		labelKey: "commands:composer_nextMessage",
		get label() {
			return uiMessage("commands:composer_nextMessage");
		},
		get description() {
			return uiMessage("commands:composer_nextMessage_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.queueSubmit": {
		labelKey: "commands:composer_queueSubmit",
		get label() {
			return uiMessage("commands:composer_queueSubmit");
		},
		get description() {
			return uiMessage("commands:composer_queueSubmit_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.deleteToStart": {
		labelKey: "commands:composer_deleteToStart",
		get label() {
			return uiMessage("commands:composer_deleteToStart");
		},
		get description() {
			return uiMessage("commands:composer_deleteToStart_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.deleteToEnd": {
		labelKey: "commands:composer_deleteToEnd",
		get label() {
			return uiMessage("commands:composer_deleteToEnd");
		},
		get description() {
			return uiMessage("commands:composer_deleteToEnd_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.deleteWord": {
		labelKey: "commands:composer_deleteWord",
		get label() {
			return uiMessage("commands:composer_deleteWord");
		},
		get description() {
			return uiMessage("commands:composer_deleteWord_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.yank": {
		labelKey: "commands:composer_yank",
		get label() {
			return uiMessage("commands:composer_yank");
		},
		get description() {
			return uiMessage("commands:composer_yank_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.yankPop": {
		labelKey: "commands:composer_yankPop",
		get label() {
			return uiMessage("commands:composer_yankPop");
		},
		get description() {
			return uiMessage("commands:composer_yankPop_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.stash": {
		labelKey: "commands:composer_stash",
		get label() {
			return uiMessage("commands:composer_stash");
		},
		get description() {
			return uiMessage("commands:composer_stash_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.searchHistory": {
		labelKey: "commands:composer_searchHistory",
		get label() {
			return uiMessage("commands:composer_searchHistory");
		},
		get description() {
			return uiMessage("commands:composer_searchHistory_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.interrupt": {
		labelKey: "commands:composer_interrupt",
		get label() {
			return uiMessage("commands:composer_interrupt");
		},
		get description() {
			return uiMessage("commands:composer_interrupt_description");
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"composer.togglePlanMode": {
		labelKey: "commands:default_keybindings_toggle_plan_mode",
		get label() {
			return uiMessage("commands:default_keybindings_toggle_plan_mode");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_switch_between_normal_and_plan_mode_composer",
			);
		},
		get group() {
			return uiMessage("commands:command_group_composer");
		},
	},
	"editor.save": {
		labelKey: "commands:default_keybindings_save_file",
		get label() {
			return uiMessage("commands:default_keybindings_save_file");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_write_the_open_file_to_disk",
			);
		},
		get group() {
			return uiMessage("commands:command_group_editor");
		},
	},
	"editor.annotate": {
		labelKey: "commands:default_keybindings_annotate_selection",
		get label() {
			return uiMessage("commands:default_keybindings_annotate_selection");
		},
		get description() {
			return uiMessage(
				"commands:default_keybindings_pin_a_comment_on_the_selected_code_and_add_it_to_the_composer",
			);
		},
		get group() {
			return uiMessage("commands:command_group_editor");
		},
	},
};

export const COMMANDS_IN_ORDER: ReadonlyArray<Command> = Object.keys(
	COMMAND_META,
) as Command[];

/**
 * Default rules merged on top of (or under) the user's `keybindings.json`
 * overrides. The matcher walks rules last-first so a user rule with the
 * same `command` shadows the default; otherwise the default still applies
 * (multiple keys → same command is fine).
 *
 * Scoping is structural rather than expression-based:
 *   - `composer.*` bindings only live inside the composer's CodeMirror
 *     keymap (built in `composer-keymap.ts`).
 *   - `editor.*` bindings only live inside the file editor's keymap
 *     (built in `setup.ts`).
 *   - Everything else is global, dispatched by `useKeybindingDispatch`.
 *
 * The wire type still carries an optional `when` field for power users
 * who hand-edit `keybindings.json` — the dispatcher's evaluator is wired
 * up but the settings UI no longer exposes a builder. See
 * `packages/contracts/src/keybindings-parse.ts` for the AST.
 */
export const DEFAULT_KEYBINDINGS: ReadonlyArray<KeybindingRule> = [
	{ key: "mod+n", command: "new-chat" },
	{ key: "mod+alt+n", command: "new-chat-without-project" },
	{ key: "mod+o", command: "open-project" },
	{ key: "mod+,", command: "settings" },
	{ key: "mod+w", command: "close-tab" },
	{ key: "mod+b", command: "toggle-left-sidebar" },
	{ key: "mod+alt+b", command: "toggle-right-sidebar" },
	{ key: "mod+j", command: "toggle-terminal" },
	{ key: "mod+l", command: "focus-composer" },

	{ key: "mod+shift+]", command: "next-tab" },
	{ key: "mod+shift+[", command: "prev-tab" },
	{ key: "mod+1", command: "select-tab-1" },
	{ key: "mod+2", command: "select-tab-2" },
	{ key: "mod+3", command: "select-tab-3" },
	{ key: "mod+4", command: "select-tab-4" },
	{ key: "mod+5", command: "select-tab-5" },
	{ key: "mod+6", command: "select-tab-6" },
	{ key: "mod+7", command: "select-tab-7" },
	{ key: "mod+8", command: "select-tab-8" },
	{ key: "mod+9", command: "select-last-tab" },
	{ key: "mod+t", command: "new-tab" },
	{ key: "ctrl+tab", command: "next-chat" },
	{ key: "ctrl+shift+tab", command: "prev-chat" },
	{ key: "mod+alt+]", command: "next-panel" },
	{ key: "mod+alt+[", command: "prev-panel" },
	{ key: "ctrl+`", command: "focus-next-pane" },
	{ key: "ctrl+shift+`", command: "focus-prev-pane" },
	{ key: "mod+k", command: "open-chat-switcher" },
	{ key: "mod+p", command: "search-files" },
	{ key: "mod+/", command: "show-shortcuts" },
	{ key: "mod+f", command: "find-in-chat" },
	{ key: "alt+p", command: "open-model-picker" },
	{ key: "alt+t", command: "cycle-reasoning-effort" },
	{ key: "alt+o", command: "toggle-fast-mode" },
	{ key: IS_MAC ? "ctrl+o" : "ctrl+shift+o", command: "toggle-tool-details" },
	{ key: IS_MAC ? "ctrl+t" : "ctrl+shift+t", command: "toggle-task-list" },
	{ key: "mod+shift+k", command: "stop-background-tasks" },
	{ key: "enter", command: "composer.submit" },
	{ key: "shift+enter", command: "composer.newline" },
	{ key: "mod+enter", command: "composer.forceSubmit" },
	{ key: "shift+tab", command: "composer.togglePlanMode" },
	{ key: "up", command: "composer.previousMessage" },
	{ key: "down", command: "composer.nextMessage" },
	{ key: "alt+enter", command: "composer.queueSubmit" },
	{ key: "ctrl+u", command: "composer.deleteToStart" },
	{ key: "ctrl+k", command: "composer.deleteToEnd" },
	{ key: "ctrl+backspace", command: "composer.deleteWord" },
	{ key: "alt+backspace", command: "composer.deleteWord" },
	{ key: "ctrl+y", command: "composer.yank" },
	{ key: "alt+y", command: "composer.yankPop" },
	{ key: "ctrl+s", command: "composer.stash" },
	{ key: IS_MAC ? "ctrl+r" : "alt+r", command: "composer.searchHistory" },
	{ key: "escape", command: "composer.interrupt" },
	{ key: "mod+s", command: "editor.save" },
	{ key: "mod+shift+a", command: "editor.annotate" },
];

/**
 * Merge user overrides on top of defaults. User rules win when they share
 * the same `command`. Other defaults stay — so a user can add a *new*
 * binding for an action without losing the existing one.
 */
export function mergeWithDefaults(
	userRules: ReadonlyArray<KeybindingRule>,
): ReadonlyArray<KeybindingRule> {
	const out: KeybindingRule[] = [];
	const overriddenCommands = new Set(userRules.map((r) => r.command));
	for (const def of DEFAULT_KEYBINDINGS) {
		if (!overriddenCommands.has(def.command)) out.push(def);
	}
	out.push(...userRules);
	return out;
}
