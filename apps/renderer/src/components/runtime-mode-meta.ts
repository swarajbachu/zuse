import "@zuse/i18n/english/chat";
import type { IconSvgElement } from "@hugeicons/react";
import type { RuntimeMode } from "@zuse/contracts";
import { message as uiMessage } from "@zuse/i18n";
import {
	LockIcon,
	PencilEdit01Icon,
	Shield01Icon,
	SquareUnlock01Icon,
	TerminalIcon,
} from "@zuse/icons/solid-rounded";

/**
 * Shared label/description/icon for each runtime mode. Used by the composer's
 * permission menu and the Settings page's "Default permission mode" radio
 * cards so they stay perfectly in sync.
 *
 * Legacy modes remain displayable for persisted sessions; new selections
 * use the three access postures in MODES_ORDER.
 */
export type ModeMeta = {
	readonly label: string;
	readonly description: string;
	readonly Icon: IconSvgElement;
};

export const MODE_META: Record<RuntimeMode, ModeMeta> = {
	auto: {
		get label() {
			return uiMessage("chat:runtime_mode_approve_for_me");
		},
		get description() {
			return uiMessage("chat:runtime_mode_auto_description");
		},
		Icon: Shield01Icon,
	},
	"approval-required": {
		get label() {
			return uiMessage("chat:runtime_mode_ask_for_approval");
		},
		get description() {
			return uiMessage("chat:runtime_mode_approval_description");
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
			return uiMessage("chat:runtime_mode_full_description");
		},
		Icon: SquareUnlock01Icon,
	},
};

export const MODES_ORDER: ReadonlyArray<RuntimeMode> = [
	"approval-required",
	"auto",
	"full-access",
];
