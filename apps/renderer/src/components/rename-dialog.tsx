import type { FormEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { formatError } from "../lib/format-error.ts";
import { Button } from "./ui/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogPanel,
	DialogPopup,
	DialogTitle,
} from "./ui/dialog.tsx";
import { Input } from "./ui/input.tsx";

export function RenameDialog({
	description,
	label,
	open,
	onOpenChange,
	onRename,
	title,
	value: initialValue,
}: {
	readonly description: string;
	readonly label: string;
	readonly open: boolean;
	readonly onOpenChange: (open: boolean) => void;
	readonly onRename: (value: string) => Promise<void>;
	readonly title: string;
	readonly value: string;
}) {
	const inputRef = useRef<HTMLInputElement>(null);
	const inputId = useId();
	const errorId = `${inputId}-error`;
	const [value, setValue] = useState(initialValue);
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setValue(initialValue);
		setError(null);
		requestAnimationFrame(() => inputRef.current?.select());
	}, [initialValue, open]);

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const trimmed = value.trim();
		if (trimmed.length === 0) {
			setError(`${label} cannot be empty.`);
			return;
		}
		if (trimmed === initialValue) {
			onOpenChange(false);
			return;
		}
		setSubmitting(true);
		setError(null);
		try {
			await onRename(trimmed);
			onOpenChange(false);
		} catch (cause) {
			setError(formatError(cause));
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogPopup className="max-w-sm">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<form className="contents" onSubmit={(event) => void submit(event)}>
					<DialogPanel className="flex flex-col gap-2">
						<label htmlFor={inputId} className="font-medium text-xs">
							{label}
						</label>
						<Input
							ref={inputRef}
							id={inputId}
							autoComplete="off"
							spellCheck={false}
							value={value}
							onChange={(event) => setValue(event.currentTarget.value)}
							aria-invalid={error !== null}
							aria-describedby={error === null ? undefined : errorId}
						/>
						{error !== null ? (
							<p id={errorId} className="text-destructive text-xs">
								{error}
							</p>
						) : null}
					</DialogPanel>
					<DialogFooter>
						<DialogClose type="button" disabled={submitting}>
							Cancel
						</DialogClose>
						<Button type="submit" disabled={submitting} loading={submitting}>
							Rename
						</Button>
					</DialogFooter>
				</form>
			</DialogPopup>
		</Dialog>
	);
}
