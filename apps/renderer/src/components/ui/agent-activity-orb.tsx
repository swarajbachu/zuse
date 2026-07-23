import type React from "react";
import { ThinkingOrb } from "thinking-orbs";
import type { AgentActivityState } from "~/lib/agent-activity-state";
import { cn } from "~/lib/utils";

type AgentActivityOrbProps = {
	readonly state?: AgentActivityState;
	readonly label?: string;
	readonly size?: "compact" | "prominent";
	readonly className?: string;
};

const PIXELS_BY_SIZE = {
	compact: 20,
	prominent: 64,
} as const;

/**
 * Project wrapper for agent-only activity. The dependency owns theme changes,
 * reduced-motion rendering, and offscreen/hidden-tab pausing.
 */
export function AgentActivityOrb({
	state = "working",
	label,
	size = "compact",
	className,
}: AgentActivityOrbProps): React.ReactElement {
	return (
		<ThinkingOrb
			state={state}
			size={PIXELS_BY_SIZE[size]}
			theme="auto"
			aria-label={label}
			className={cn("shrink-0", className)}
		/>
	);
}
