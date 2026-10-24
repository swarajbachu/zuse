"use client";
import { DitherButtonBackground } from "@repo/ui/dither";
import { Check, Link2 } from "lucide-react";
import { useState } from "react";

export function ShareProfile() {
	const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
	return (
		<div className="flex items-center gap-3">
			<span
				role="status"
				className="font-mono text-[11px] text-muted-foreground"
			>
				{status === "copied"
					? "Link copied"
					: status === "failed"
						? "Copy the URL from your address bar"
						: ""}
			</span>
			<button
				type="button"
				aria-label="Copy profile link"
				className="relative isolate flex h-8 shrink-0 items-center gap-2 overflow-hidden rounded-md bg-background px-3 font-mono text-xs font-bold text-foreground outline-none transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-2"
				onClick={() => {
					void navigator.clipboard
						.writeText(window.location.href)
						.then(() => setStatus("copied"))
						.catch(() => setStatus("failed"));
				}}
			>
				<DitherButtonBackground />
				{status === "copied" ? (
					<Check className="size-3.5" />
				) : (
					<Link2 className="size-3.5" />
				)}
				<span className="[text-shadow:0_1px_3px_var(--color-background)]">
					Copy link
				</span>
			</button>
		</div>
	);
}
