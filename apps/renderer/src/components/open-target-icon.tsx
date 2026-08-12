import { HugeiconsIcon } from "@hugeicons/react";
import {
	CodeIcon,
	CursorInWindowIcon,
	FolderOpenIcon,
	TerminalIcon,
	VisualStudioCodeIcon,
} from "@zuse/icons/solid-rounded";

import type { OpenTarget } from "../lib/bridge.ts";

const fallbackIconForTarget = (targetId: string) => {
	switch (targetId) {
		case "finder":
			return FolderOpenIcon;
		case "vscode":
			return VisualStudioCodeIcon;
		case "cursor":
			return CursorInWindowIcon;
		case "ghostty":
		case "terminal":
			return TerminalIcon;
		default:
			return CodeIcon;
	}
};

export function OpenTargetIcon({ target }: { target: OpenTarget }) {
	if (target.iconDataUrl === null || target.iconDataUrl === undefined) {
		return (
			<HugeiconsIcon
				icon={fallbackIconForTarget(target.id)}
				className="size-5 shrink-0 text-muted-foreground"
			/>
		);
	}
	return (
		<img
			alt=""
			src={target.iconDataUrl}
			className="size-5 shrink-0 rounded-[4px]"
		/>
	);
}
