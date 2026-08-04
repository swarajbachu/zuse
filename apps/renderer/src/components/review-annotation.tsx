import type { CodeAnnotation } from "@zuse/contracts";
import {
	ArrowUp,
	Bot,
	GitPullRequest,
	type LucideIcon,
	Pencil,
	Sparkles,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAnnotationsStore } from "../store/annotations.ts";
import type { useSessionsStore } from "../store/sessions.ts";
import { useUiStore } from "../store/ui.ts";
import { Button } from "./ui/button.tsx";

export type AnnotationDestination = "ai" | "github";

export type AnnotationAuthor = {
	readonly name: string;
	readonly avatarUrl: string | null;
	readonly initial: string;
};

export function DraftReviewAnnotation({
	author,
	aiDisabledReason,
	githubEnabled = true,
	error,
	onCancel,
	onSave,
}: {
	readonly author: AnnotationAuthor;
	readonly aiDisabledReason: string | null;
	readonly githubEnabled?: boolean;
	readonly error: string | null;
	readonly onCancel: () => void;
	readonly onSave: (
		message: string,
		destination: AnnotationDestination,
	) => Promise<boolean>;
}) {
	const [message, setMessage] = useState("");
	const [destination, setDestination] = useState<AnnotationDestination>("ai");
	const [submitting, setSubmitting] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const trimmedMessage = message.trim();
	const disabledReason = destination === "ai" ? aiDisabledReason : null;
	const disabled = disabledReason !== null;

	useEffect(() => {
		if (disabled || "ontouchstart" in window) return;
		textareaRef.current?.focus({ preventScroll: true });
	}, [disabled]);

	const tryCancel = () => {
		if (
			trimmedMessage.length > 0 &&
			!window.confirm("Discard this annotation draft?")
		)
			return;
		onCancel();
	};

	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault();
				if (disabled || submitting || trimmedMessage.length === 0) return;
				setSubmitting(true);
				const saved = await onSave(trimmedMessage, destination);
				if (!saved) setSubmitting(false);
			}}
			className="m-2 flex max-w-[600px] gap-2.5 rounded-xl border border-border/70 bg-card p-3 font-sans text-card-foreground shadow-[0_2px_4px_rgb(0_0_0_/_0.03),0_4px_10px_rgb(0_0_0_/_0.03)]"
		>
			<AnnotationAvatar author={author} />
			<div className="min-w-0 flex-1">
				<div className="flex min-h-5 items-center gap-2 text-xs">
					<span className="min-w-0 truncate font-medium text-foreground">
						{author.name}
					</span>
				</div>
				<textarea
					ref={textareaRef}
					value={message}
					onChange={(event) => setMessage(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.preventDefault();
							tryCancel();
						} else if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
					placeholder={
						disabled
							? "Chat session required"
							: destination === "github"
								? "Post a review comment…"
								: "Add an annotation for AI…"
					}
					disabled={disabled || submitting}
					rows={2}
					spellCheck={false}
					className="field-sizing-content mt-1 min-h-12 w-full resize-none bg-transparent py-1 text-sm leading-5 text-foreground caret-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
				/>
				{disabledReason !== null || error !== null ? (
					<p className="mt-1 text-xs text-rose-400" role="alert">
						{error ?? disabledReason}
					</p>
				) : null}
				<div className="mt-2 flex items-center justify-end gap-1">
					{githubEnabled ? (
						<fieldset
							aria-label="Annotation destination"
							className="mr-0.5 flex shrink-0 items-center rounded-md border-0 bg-foreground/5 p-0.5"
						>
							<DestinationOption
								active={destination === "ai"}
								label="AI"
								onClick={() => setDestination("ai")}
								icon={Bot}
							/>
							<DestinationOption
								active={destination === "github"}
								label="GitHub"
								onClick={() => setDestination("github")}
								icon={GitPullRequest}
							/>
						</fieldset>
					) : null}
					<button
						type="button"
						aria-label="Cancel annotation"
						title="Cancel annotation (Esc)"
						onClick={tryCancel}
						disabled={submitting}
						className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
					>
						<X className="size-3.5" aria-hidden="true" />
					</button>
					<button
						type="submit"
						aria-label="Save annotation"
						title="Save annotation (Enter)"
						disabled={disabled || submitting || trimmedMessage.length === 0}
						className="grid size-7 place-items-center rounded-md bg-foreground text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:bg-foreground/10 disabled:text-muted-foreground"
					>
						<ArrowUp className="size-4" aria-hidden="true" />
					</button>
				</div>
			</div>
		</form>
	);
}

function DestinationOption({
	active,
	label,
	icon: Icon,
	onClick,
}: {
	readonly active: boolean;
	readonly label: string;
	readonly icon: LucideIcon;
	readonly onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-pressed={active}
			aria-label={`Send annotation to ${label}`}
			title={`Send to ${label}`}
			onClick={onClick}
			className={`flex h-6 items-center gap-1 rounded px-1.5 text-[10px] ${active ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
		>
			<Icon className="size-3" aria-hidden="true" />
			{label}
		</button>
	);
}

function AnnotationAvatar({ author }: { readonly author: AnnotationAuthor }) {
	const [imageFailed, setImageFailed] = useState(false);
	useEffect(() => setImageFailed(false), [author.avatarUrl]);
	return (
		<div className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-xs font-medium text-muted-foreground">
			{author.avatarUrl !== null && !imageFailed ? (
				<img
					src={author.avatarUrl}
					alt={author.name}
					className="size-full object-cover"
					referrerPolicy="no-referrer"
					onError={() => setImageFailed(true)}
				/>
			) : (
				author.initial
			)}
		</div>
	);
}

export function SavedReviewAnnotation({
	annotation,
	author,
	sessionId,
}: {
	readonly annotation: CodeAnnotation;
	readonly author: AnnotationAuthor;
	readonly sessionId: ReturnType<
		typeof useSessionsStore.getState
	>["selectedSessionId"];
}) {
	const [editing, setEditing] = useState(false);
	const [comment, setComment] = useState(annotation.comment);
	useEffect(() => {
		if (!editing) setComment(annotation.comment);
	}, [annotation.comment, editing]);
	return (
		<div
			className="group m-2 flex max-w-[600px] gap-2.5 rounded-xl border border-border/70 bg-card p-3 font-sans text-sm text-card-foreground shadow-[0_2px_4px_rgb(0_0_0_/_0.03),0_4px_10px_rgb(0_0_0_/_0.03)]"
			onPointerDown={(event) => event.stopPropagation()}
		>
			<AnnotationAvatar author={author} />
			<div className="min-w-0 flex-1">
				<div className="flex min-h-7 items-center gap-2">
					<strong className="min-w-0 truncate font-medium text-foreground">
						{author.name}
					</strong>
					<span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 px-1.5 py-0.5 text-[10px] text-muted-foreground">
						<Sparkles className="size-2.5" aria-hidden="true" /> For AI
					</span>
					<span className="ml-auto truncate font-mono text-[10px] text-muted-foreground">
						{annotation.startLine === annotation.endLine
							? `Line ${annotation.startLine}`
							: `Lines ${annotation.startLine}–${annotation.endLine}`}
					</span>
					{!editing ? (
						<div className="flex items-center gap-0.5">
							<button
								type="button"
								onClick={() => setEditing(true)}
								aria-label="Edit annotation"
								title="Edit annotation"
								className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
							>
								<Pencil className="size-3" aria-hidden="true" />
							</button>
							<button
								type="button"
								onClick={() => {
									useAnnotationsStore.getState().removeById(annotation.id);
									if (
										useUiStore.getState().revealedAnnotation?.id ===
										annotation.id
									) {
										useUiStore.getState().clearRevealedAnnotation();
									}
								}}
								aria-label="Delete annotation"
								title="Delete annotation"
								className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-rose-500/10 hover:text-rose-400"
							>
								<Trash2 className="size-3" aria-hidden="true" />
							</button>
						</div>
					) : null}
				</div>
				{editing ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							if (sessionId === null) return;
							useAnnotationsStore
								.getState()
								.updateComment(sessionId, annotation.id, comment);
							setEditing(false);
						}}
						className="mt-1"
					>
						<textarea
							value={comment}
							onChange={(event) => setComment(event.target.value)}
							rows={2}
							className="min-h-12 w-full resize-y bg-transparent px-0 py-1 text-sm leading-5 text-foreground caret-foreground outline-none placeholder:text-muted-foreground"
						/>
						<div className="mt-2 flex justify-end gap-1.5">
							<Button
								type="button"
								size="sm"
								variant="ghost"
								onClick={() => {
									setComment(annotation.comment);
									setEditing(false);
								}}
							>
								Cancel
							</Button>
							<Button
								type="submit"
								size="sm"
								disabled={comment.trim().length === 0}
							>
								Save annotation
							</Button>
						</div>
					</form>
				) : (
					<p className="mt-1 whitespace-pre-wrap leading-5 text-foreground">
						{annotation.comment}
					</p>
				)}
			</div>
		</div>
	);
}
