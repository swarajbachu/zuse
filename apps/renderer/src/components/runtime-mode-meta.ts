import "@zuse/i18n/english/chat";
import type { IconSvgElement } from "@hugeicons/react";
import type { RuntimeMode } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import {
	LockIcon,
	PencilEdit01Icon,
	SquareUnlock01Icon,
	TerminalIcon,
} from "@zuse/icons/solid-rounded";

/**
 * Shared label/description/icon for each runtime mode. Used by the composer's
 * permission menu and the Settings page's "Default permission mode" radio
 * cards so they stay perfectly in sync.
 *
 * Descriptions spell out exactly which tools each mode skips and which it
 * still prompts on — the user feedback was that the previous one-line
 * copy left them guessing why `Auto-accept edits` still asked for Bash.
 */
export type ModeMeta = {
	readonly label: string;
	readonly description: string;
	readonly Icon: IconSvgElement;
};

export const MODE_META: Record<RuntimeMode, ModeMeta> = {
	"approval-required": {
		get label() {
			return uiMessage("chat:runtime_mode_meta_supervised");
		},
		get description() {
			return uiMessage(
				"chat:runtime_mode_meta_asks_before_every_bash_file_edit_web_request_or_mcp_call_read_onl",
			);
		},
		Icon: LockIcon,
	},
	"auto-accept-edits": {
		get label() {
			return uiMessage("chat:runtime_mode_meta_auto_accept_edits");
		},
		get description() {
			return uiMessage(
				"chat:runtime_mode_meta_auto_allows_edit_write_multiedit_notebookedit_still_asks_for_bash",
			);
		},
		Icon: PencilEdit01Icon,
	},
	"auto-accept-edits-and-bash": {
		get label() {
			return uiMessage("chat:runtime_mode_meta_auto_accept_edits_bash");
		},
		get description() {
			return uiMessage(
				"chat:runtime_mode_meta_auto_allows_edits_and_bash_commands_still_asks_for_webfetch_webse",
			);
		},
		Icon: TerminalIcon,
	},
	"full-access": {
		get label() {
			return uiMessage("chat:runtime_mode_meta_full_access");
		},
		get description() {
			return uiMessage(
				"chat:runtime_mode_meta_auto_allows_everything_plan_mode_and_sensitive_paths_env_ssh_cred",
			);
		},
		Icon: SquareUnlock01Icon,
	},
};

export const MODES_ORDER: ReadonlyArray<RuntimeMode> = [
	"approval-required",
	"auto-accept-edits",
	"auto-accept-edits-and-bash",
	"full-access",
];
