import { useMessages as useUiMessages } from "@zuse/i18n/react";
import { useEffect, useRef, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { cn } from "../lib/utils.ts";
import { toastManager } from "./ui/toast.tsx";

/** A plain double-click starts a rename; modified clicks keep their own meaning. */
export const isRenameDoubleClick = (
	event: Pick<MouseEvent, "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
): boolean =>
	!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;

/**
 * Edits a name in place. Enter or leaving the field saves, Escape cancels.
 * The field stays up with the typed name until the save settles, so the old
 * name never flashes back.
 */
export function InlineRenameInput({
	value: initialValue,
	label,
	onRename,
	onDone,
	className,
}: {
	readonly value: string;
	readonly label: string;
	readonly onRename: (value: string) => Promise<void>;
	readonly onDone: () => void;
	readonly className?: string;
}) {
	const { message: uiMessage } = useUiMessages(["common"]);
	const inputRef = useRef<HTMLInputElement>(null);
	const [value, setValue] = useState(initialValue);
	const [saving, setSaving] = useState(false);
	const settledRef = useRef(false);

	useEffect(() => {
		// A closing context menu restores focus after this mounts.
		const frame = requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
		return () => cancelAnimationFrame(frame);
	}, []);

	const finish = () => {
		if (settledRef.current) return;
		settledRef.current = true;
		onDone();
	};

	const commit = async () => {
		if (saving || settledRef.current) return;
		const trimmed = value.trim();
		if (trimmed.length === 0 || trimmed === initialValue) {
			finish();
			return;
		}
		setSaving(true);
		try {
			await onRename(trimmed);
			finish();
		} catch (cause) {
			setSaving(false);
			toastManager.add({
				type: "error",
				title: uiMessage("common:rename_failed"),
				description: formatError(cause),
			});
			// Leaving the field gives up on the edit; Enter keeps it to retry.
			if (document.activeElement !== inputRef.current) finish();
		}
	};

	return (
		<input
			ref={inputRef}
			aria-label={label}
			autoComplete="off"
			spellCheck={false}
			dir="auto"
			readOnly={saving}
			value={value}
			onChange={(event) => setValue(event.currentTarget.value)}
			onKeyDown={(event) => {
				event.stopPropagation();
				// Enter and Escape belong to an input method while it composes.
				if (event.nativeEvent.isComposing || event.keyCode === 229) return;
				if (event.key === "Enter") {
					event.preventDefault();
					void commit();
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish();
				}
			}}
			onBlur={() => void commit()}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onPointerDown={(event) => event.stopPropagation()}
			className={cn(
				"pointer-events-auto relative z-10 -mx-1 min-w-0 rounded-sm bg-background/60 px-1 text-inherit outline-none ring-1 ring-ring/70",
				className,
			)}
		/>
	);
}
