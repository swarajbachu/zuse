"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

type Status =
	| { state: "idle" }
	| { state: "submitting" }
	| { state: "success" }
	| { state: "error"; message: string };

export const WaitlistForm = () => {
	const [email, setEmail] = useState("");
	const [status, setStatus] = useState<Status>({ state: "idle" });

	const submitting = status.state === "submitting";

	const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (submitting) return;
		setStatus({ state: "submitting" });
		try {
			const response = await fetch("/api/waitlist", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email }),
			});
			if (!response.ok) {
				const body = (await response.json().catch(() => null)) as {
					error?: string | { message?: string };
				} | null;
				const message =
					typeof body?.error === "string" ? body.error : body?.error?.message;
				setStatus({
					state: "error",
					message: message ?? "Something went wrong. Please try again.",
				});
				return;
			}
			setStatus({ state: "success" });
			setEmail("");
		} catch {
			setStatus({
				state: "error",
				message: "Something went wrong. Please try again.",
			});
		}
	};

	if (status.state === "success") {
		return (
			<p className="text-primary flex h-11 items-center text-sm font-medium">
				Interest registered. We'll email you about beta access.
			</p>
		);
	}

	return (
		<form
			onSubmit={handleSubmit}
			className="flex w-full max-w-[360px] flex-col gap-2"
		>
			<div className="flex gap-2">
				<input
					type="email"
					name="email"
					required
					autoComplete="email"
					placeholder="you@example.com"
					aria-label="Email address"
					value={email}
					onChange={(event) => {
						setEmail(event.target.value);
						if (status.state === "error") setStatus({ state: "idle" });
					}}
					className="border-border bg-background text-heading placeholder:text-muted-foreground h-11 min-w-0 w-full rounded-lg border px-3 text-base outline-none focus-visible:border-foreground/50 focus-visible:ring-2 focus-visible:ring-foreground/20"
				/>
				<button
					type="submit"
					disabled={submitting}
					className={cn(
						"bg-primary text-primary-foreground h-11 shrink-0 rounded-lg px-4 text-[13px] font-semibold transition-opacity duration-200 active:scale-[0.97] motion-reduce:transform-none",
						submitting ? "opacity-60" : "hover:opacity-90",
					)}
				>
					{submitting ? "Sending…" : "Request access"}
				</button>
			</div>
			{/* Fixed-height status row so errors never shift the layout. */}
			<p
				role="status"
				className="text-dusty-red h-5 text-xs font-medium"
				aria-live="polite"
			>
				{status.state === "error" ? status.message : ""}
			</p>
		</form>
	);
};
