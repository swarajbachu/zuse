import "@zuse/i18n/english/common";
import "@zuse/i18n/english/tools";
import { HugeiconsIcon } from "@hugeicons/react";
import { DitherDotField } from "@repo/ui/dither";
import { useMessages } from "@zuse/i18n/react";
import {
	AlertCircleIcon,
	Copy01Icon,
	LinkSquare02Icon,
	Tick02Icon,
} from "@zuse/icons/solid-rounded";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { copyImage } from "~/lib/platform-capabilities";
import {
	generatedImagePath,
	generatedImagePrompt,
	toolImageDataUrl,
	toolImageDimensions,
	toolImageResult,
} from "~/lib/tool-image-result";
import { cn } from "~/lib/utils";
import { useUiStore } from "~/store/ui";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip.tsx";

type GenerationStatus = "generating" | "complete" | "error";

interface GeneratedImageResult {
	readonly output: unknown;
	readonly isError: boolean;
}

const EASE_OUT = [0.22, 1, 0.36, 1] as const;

const MEDIA_STATE = {
	generating: { filter: "blur(3px) saturate(0.85)", opacity: 0, scale: 1.015 },
	complete: { filter: "blur(0px) saturate(1)", opacity: 1, scale: 1 },
} as const;

const formatElapsed = (ms: number): string => {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/**
 * A model-generated image. A drifting dot field holds the frame while the
 * image is generated, then the image resolves into place. Images loaded from
 * history appear without replaying the reveal.
 */
export function GeneratedImageCard({
	result,
	startedAt,
}: {
	readonly result: GeneratedImageResult | undefined;
	readonly startedAt: Date;
}) {
	const { message } = useMessages(["common", "tools"]);
	const reduce = useReducedMotion() ?? false;
	const [mountedPending] = useState(() => result === undefined);
	const output = result?.output;
	const image = useMemo(() => {
		const found = toolImageResult(output);
		return found === null
			? null
			: { src: toolImageDataUrl(found), size: toolImageDimensions(found) };
	}, [output]);

	const status: GenerationStatus =
		result === undefined
			? "generating"
			: result.isError || image === null
				? "error"
				: "complete";
	const active = status === "generating";
	const prompt = generatedImagePrompt(output);
	const label =
		status === "generating"
			? message("tools:tool_row_generating_image")
			: status === "complete"
				? message("tools:tool_row_generated_image")
				: message("tools:tool_row_image_generation_failed");

	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, [active]);

	return (
		<figure aria-busy={active} className="ps-4.5 pe-4 py-1.5">
			<div className="w-full max-w-80">
				{status !== "error" ? (
					<div
						role="img"
						aria-label={prompt === null ? label : `${label}: ${prompt}`}
						style={{
							aspectRatio:
								image?.size == null
									? "1 / 1"
									: `${image.size.width} / ${image.size.height}`,
						}}
						className="group/image relative isolate w-full overflow-hidden rounded-xl bg-muted transition-[aspect-ratio] duration-300 ease-out motion-reduce:transition-none"
					>
						{image !== null ? (
							<motion.img
								src={image.src}
								alt=""
								draggable={false}
								initial={
									mountedPending && !reduce ? MEDIA_STATE.generating : false
								}
								animate={reduce ? { opacity: 1 } : MEDIA_STATE.complete}
								transition={{
									duration: reduce ? 0 : 0.5,
									ease: EASE_OUT,
								}}
								className="absolute inset-0 size-full object-cover"
							/>
						) : null}
						<AnimatePresence initial={false}>
							{active ? (
								<motion.div
									key="dot-field"
									initial={{ opacity: 0 }}
									animate={{ opacity: 1 }}
									exit={{ opacity: 0 }}
									transition={{ duration: reduce ? 0 : 0.35, ease: EASE_OUT }}
									className="absolute inset-0"
								>
									<DitherDotField className="absolute inset-0 bg-muted text-foreground" />
								</motion.div>
							) : null}
						</AnimatePresence>
						{image?.size != null ? (
							<span className="absolute top-2 right-2 z-10 rounded-full bg-background/75 px-2 py-0.5 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur-sm">
								{image.size.width} × {image.size.height}
							</span>
						) : null}
						{image !== null ? (
							<ImageActions src={image.src} path={generatedImagePath(output)} />
						) : null}
					</div>
				) : null}
				<figcaption className={cn(status !== "error" && "mt-2.5")}>
					<div
						aria-live="polite"
						className={cn(
							"flex min-h-5 items-center gap-2 font-medium text-xs text-foreground/90",
							status === "error" && "text-destructive",
						)}
					>
						<StatusMark status={status} reduce={reduce} />
						<AnimatePresence mode="popLayout" initial={false}>
							<motion.span
								key={status}
								initial={reduce ? false : { opacity: 0, y: 4 }}
								animate={{ opacity: 1, y: 0 }}
								exit={reduce ? undefined : { opacity: 0, y: -4 }}
								transition={{ duration: reduce ? 0 : 0.15, ease: EASE_OUT }}
							>
								{label}
							</motion.span>
						</AnimatePresence>
						{active ? (
							<span className="font-normal tabular-nums text-muted-foreground">
								{formatElapsed(now - startedAt.getTime())}
							</span>
						) : null}
					</div>
					{prompt !== null ? (
						<p
							className="mt-0.5 truncate text-[11px] text-muted-foreground"
							title={prompt}
						>
							“{prompt}”
						</p>
					) : null}
				</figcaption>
			</div>
		</figure>
	);
}

function StatusMark({
	status,
	reduce,
}: {
	readonly status: GenerationStatus;
	readonly reduce: boolean;
}) {
	if (status !== "generating") {
		return (
			<HugeiconsIcon
				icon={status === "complete" ? Tick02Icon : AlertCircleIcon}
				strokeWidth={2}
				aria-hidden="true"
				className="size-3.5"
			/>
		);
	}
	return (
		<motion.span
			aria-hidden="true"
			animate={reduce ? undefined : { rotate: 360 }}
			transition={{
				duration: 2.4,
				ease: "easeInOut",
				repeat: Number.POSITIVE_INFINITY,
			}}
			className="grid size-3.5 grid-cols-2 place-items-center gap-0.5"
		>
			<span className="size-1 rounded-[1px] bg-current" />
			<span className="size-1 rounded-[1px] bg-current opacity-55" />
			<span className="size-1 rounded-[1px] bg-current opacity-55" />
			<span className="size-1 rounded-[1px] bg-current" />
		</motion.span>
	);
}

function ImageActions({
	src,
	path,
}: {
	readonly src: string;
	readonly path: string | null;
}) {
	const { message } = useMessages(["common", "tools"]);
	const openFileInTab = useUiStore((s) => s.openFileInTab);
	const openTarget = {
		kind: "image" as const,
		src,
		name:
			path?.split(/[\\/]/).pop() || message("tools:tool_row_generated_image"),
	};
	const [copy, setCopy] = useState<"idle" | "copied" | "error">("idle");
	useEffect(() => {
		if (copy === "idle") return;
		const timer = window.setTimeout(() => setCopy("idle"), 1500);
		return () => window.clearTimeout(timer);
	}, [copy]);

	const onCopy = () => {
		void fetch(src)
			.then((response) => response.blob())
			.then(copyImage)
			.then(
				() => setCopy("copied"),
				() => setCopy("error"),
			);
	};
	const copyLabel =
		copy === "copied"
			? message("common:copied")
			: copy === "error"
				? message("common:copy_failed")
				: message("tools:tool_row_copy_image");

	return (
		<div className="absolute right-2 bottom-2 z-10 flex gap-1 opacity-0 transition-opacity duration-150 group-hover/image:opacity-100 group-focus-within/image:opacity-100 motion-reduce:transition-none">
			<ImageAction
				label={copyLabel}
				icon={copy === "copied" ? Tick02Icon : Copy01Icon}
				onClick={onCopy}
			/>
			<ImageAction
				label={message("tools:tool_row_open_image")}
				icon={LinkSquare02Icon}
				onClick={() => openFileInTab(openTarget)}
			/>
		</div>
	);
}

function ImageAction({
	label,
	icon,
	onClick,
}: {
	readonly label: string;
	readonly icon: Parameters<typeof HugeiconsIcon>[0]["icon"];
	readonly onClick: () => void;
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						type="button"
						aria-label={label}
						onClick={onClick}
						className="grid size-7 place-items-center rounded-lg bg-background/75 text-foreground outline-none backdrop-blur-sm hover:bg-background/90 focus-visible:ring-2 focus-visible:ring-ring"
					>
						<HugeiconsIcon
							icon={icon}
							strokeWidth={2}
							aria-hidden="true"
							className="size-3.5"
						/>
					</button>
				}
			/>
			<TooltipPopup>{label}</TooltipPopup>
		</Tooltip>
	);
}
