"use client";
import { PageMasthead } from "@/components/page-masthead";

export default function ProfileError({ reset }: { reset: () => void }) {
	return (
		<>
			<PageMasthead
				eyebrow="Usage profile"
				title="Profile temporarily unavailable"
				description="We could not load this profile. Please try again shortly."
			/>
			<div className="px-[clamp(1.25rem,5vw,4rem)] py-8">
				<button
					type="button"
					onClick={reset}
					className="h-8 rounded-md bg-secondary px-3 font-mono text-xs text-foreground outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary"
				>
					Try again
				</button>
			</div>
		</>
	);
}
