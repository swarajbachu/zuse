import { SKILL_ICON_PATHS } from "~/lib/skill-icon";
import { cn } from "~/lib/utils";

export function SkillIcon({ className }: { readonly className?: string }) {
	return (
		<svg
			aria-hidden
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			className={cn("shrink-0", className)}
		>
			{SKILL_ICON_PATHS.map((path) => (
				<path key={path} d={path} />
			))}
		</svg>
	);
}
