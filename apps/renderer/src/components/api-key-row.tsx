import { HugeiconsIcon } from "@hugeicons/react";
import {
	AlertCircleIcon,
	LinkSquare01Icon,
	Tick01Icon,
	ViewIcon,
	ViewOffIcon,
} from "@hugeicons-pro/core-bulk-rounded";
import type { ProviderId } from "@zuse/contracts";
import { useId, useState } from "react";

import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogPopup,
	AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { formatError } from "~/lib/format-error";
import { openExternal } from "~/lib/use-provider-login";
import { cn } from "~/lib/utils";
import { useProvidersStore } from "~/store/providers";

const API_KEY_SETTINGS_URL = "https://cursor.com/dashboard?tab=integrations";

type Feedback = {
	readonly tone: "success" | "warning" | "error";
	readonly text: string;
} | null;

/**
 * Write-only API-key form. Required providers get validation, replacement,
 * removal, and setup guidance; other providers retain the compact optional
 * save row. Stored secrets are never read back into the renderer.
 */
export function ApiKeyRow({
	providerId,
	required = false,
}: {
	providerId: ProviderId;
	required?: boolean;
}) {
	const inputId = useId();
	const feedbackId = `${inputId}-feedback`;
	const availability = useProvidersStore((state) =>
		state.availability.find((item) => item.providerId === providerId),
	);
	const setCredential = useProvidersStore((state) => state.setCredential);
	const removeCredential = useProvidersStore((state) => state.removeCredential);
	const hasKey = availability?.hasApiKey === true;
	const [value, setValue] = useState("");
	const [reveal, setReveal] = useState(false);
	const [editing, setEditing] = useState(false);
	const [busy, setBusy] = useState(false);
	const [removeOpen, setRemoveOpen] = useState(false);
	const [feedback, setFeedback] = useState<Feedback>(null);

	const onSave = async () => {
		const normalized = value.trim();
		if (normalized.length === 0 || busy) return;
		setBusy(true);
		setFeedback(null);
		try {
			const result = await setCredential(providerId, normalized);
			setValue("");
			setReveal(false);
			setEditing(false);
			setFeedback(
				result.verification === "unverified"
					? {
							tone: "warning",
							text:
								result.warning ??
								"Saved, but verification is unavailable. Recheck when online.",
						}
					: {
							tone: "success",
							text:
								result.verification === "verified"
									? "API key verified and saved."
									: "API key saved.",
						},
			);
		} catch (error) {
			setFeedback({ tone: "error", text: formatError(error) });
		} finally {
			setBusy(false);
		}
	};

	const onRemove = async () => {
		if (busy) return;
		setBusy(true);
		setFeedback(null);
		try {
			await removeCredential(providerId);
			setRemoveOpen(false);
			setEditing(true);
			setFeedback({ tone: "success", text: "API key removed." });
		} catch (error) {
			setRemoveOpen(false);
			setFeedback({ tone: "error", text: formatError(error) });
		} finally {
			setBusy(false);
		}
	};

	const persistedFeedback: Feedback =
		feedback ??
		(required && hasKey
			? availability?.apiKeyStatus === "verified"
				? { tone: "success", text: "API key verified." }
				: availability?.apiKeyStatus === "invalid"
					? {
							tone: "error",
							text:
								availability.statusMessage ??
								"The saved API key is invalid. Replace or remove it.",
						}
					: {
							tone: "warning",
							text:
								availability?.statusMessage ??
								"API key saved, but not verified.",
						}
			: null);

	if (required && hasKey && !editing) {
		return (
			<div className="flex flex-col gap-2">
				{persistedFeedback !== null && (
					<FeedbackMessage feedback={persistedFeedback} id={feedbackId} />
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="xs"
						variant="outline"
						onClick={() => {
							setFeedback(null);
							setEditing(true);
						}}
					>
						Replace key
					</Button>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						onClick={() => setRemoveOpen(true)}
					>
						Remove
					</Button>
					<Button
						type="button"
						size="xs"
						variant="ghost"
						onClick={() => openExternal(API_KEY_SETTINGS_URL)}
						className="gap-1"
					>
						Get an API key
						<HugeiconsIcon
							icon={LinkSquare01Icon}
							className="size-3"
							aria-hidden
						/>
					</Button>
				</div>
				<AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
					<AlertDialogPopup className="max-w-sm">
						<AlertDialogHeader>
							<AlertDialogTitle>Remove API key?</AlertDialogTitle>
							<AlertDialogDescription>
								New sessions will stop working until another key is added.
								Existing sessions continue until they are closed.
							</AlertDialogDescription>
						</AlertDialogHeader>
						<AlertDialogFooter>
							<AlertDialogClose render={<Button variant="ghost" />}>
								Cancel
							</AlertDialogClose>
							<Button
								variant="destructive"
								disabled={busy}
								onClick={() => void onRemove()}
							>
								{busy ? "Removing…" : "Remove key"}
							</Button>
						</AlertDialogFooter>
					</AlertDialogPopup>
				</AlertDialog>
			</div>
		);
	}

	const hasError = persistedFeedback?.tone === "error";
	return (
		<form
			className="flex flex-col gap-2"
			onSubmit={(event) => {
				event.preventDefault();
				void onSave();
			}}
		>
			{required && (
				<div className="flex items-center justify-between gap-3">
					<label
						htmlFor={inputId}
						className="text-[11px] font-medium text-muted-foreground"
					>
						API key
					</label>
					<button
						type="button"
						onClick={() => openExternal(API_KEY_SETTINGS_URL)}
						className="inline-flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
					>
						Get an API key
						<HugeiconsIcon
							icon={LinkSquare01Icon}
							className="size-3"
							aria-hidden
						/>
					</button>
				</div>
			)}
			<div className="flex items-center gap-2">
				<div className="relative flex-1">
					<Input
						id={inputId}
						type={reveal ? "text" : "password"}
						placeholder="Paste API key"
						value={value}
						onChange={(event) => setValue(event.target.value)}
						disabled={busy}
						autoComplete="off"
						spellCheck={false}
						data-1p-ignore
						data-lpignore="true"
						aria-invalid={hasError || undefined}
						aria-describedby={
							persistedFeedback !== null ? feedbackId : undefined
						}
						className="h-9 rounded-md pe-10"
					/>
					<button
						type="button"
						onClick={() => setReveal((current) => !current)}
						disabled={busy}
						className="absolute end-0 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px]"
						aria-label={reveal ? "Hide API key" : "Reveal API key"}
					>
						<HugeiconsIcon
							icon={reveal ? ViewOffIcon : ViewIcon}
							className="size-3.5"
							aria-hidden
						/>
					</button>
				</div>
				<Button
					type="submit"
					size="sm"
					disabled={busy || value.trim().length === 0}
				>
					{busy ? "Verifying…" : required ? "Verify and save" : "Save"}
				</Button>
				{required && hasKey && (
					<Button
						type="button"
						size="sm"
						variant="ghost"
						disabled={busy}
						onClick={() => {
							setValue("");
							setFeedback(null);
							setEditing(false);
						}}
					>
						Cancel
					</Button>
				)}
			</div>
			{persistedFeedback !== null && (
				<FeedbackMessage feedback={persistedFeedback} id={feedbackId} />
			)}
		</form>
	);
}

function FeedbackMessage({
	feedback,
	id,
}: {
	feedback: NonNullable<Feedback>;
	id: string;
}) {
	const isSuccess = feedback.tone === "success";
	return (
		<p
			id={id}
			role={feedback.tone === "error" ? "alert" : "status"}
			aria-live="polite"
			className={cn(
				"flex items-start gap-1.5 text-[11px] leading-snug",
				isSuccess
					? "text-emerald-400"
					: feedback.tone === "error"
						? "text-destructive"
						: "text-amber-400",
			)}
		>
			<HugeiconsIcon
				icon={isSuccess ? Tick01Icon : AlertCircleIcon}
				className="mt-px size-3.5 shrink-0"
				aria-hidden
			/>
			{feedback.text}
		</p>
	);
}
