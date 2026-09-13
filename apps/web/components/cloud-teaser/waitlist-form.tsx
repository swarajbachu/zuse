"use client";
import { useWebsiteMessages } from "@zuse/i18n/website/react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type Status =
	| { state: "idle" }
	| { state: "submitting" }
	| { state: "success" }
	| { state: "error"; message: string };

export const WaitlistForm = () => {
	const { message: t } = useWebsiteMessages();

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
				setStatus({
					state: "error",
					message: t("showcase:submit_error"),
				});
				return;
			}
			setStatus({ state: "success" });
			setEmail("");
		} catch {
			setStatus({
				state: "error",
				message: t("showcase:submit_error"),
			});
		}
	};

	if (status.state === "success") {
		return (
			<p className="text-primary flex min-h-11 items-center text-sm font-medium">
				{t("showcase:interest_registered_we_ll_email_you_about_beta_access")}
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
					placeholder={"you@example.com"}
					aria-label={t("showcase:email_address")}
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
					{submitting ? t("showcase:sending") : t("showcase:request_access")}
				</button>
			</div>
			{/* Fixed-height status row so errors never shift the layout. */}
			<p
				role="status"
				className="text-dusty-red min-h-5 text-xs font-medium"
				aria-live="polite"
			>
				{status.state === "error" ? status.message : ""}
			</p>
		</form>
	);
};
