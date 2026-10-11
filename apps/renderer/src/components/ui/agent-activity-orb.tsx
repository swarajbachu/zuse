import type React from "react";
import type { ActivityLoaderScene } from "~/lib/activity-loader-scenes";
import type { AgentActivityState } from "~/lib/agent-activity-state";
import { ActivityLoader } from "./activity-loader.tsx";

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

/** Each agent activity gets its own motion so the state reads at a glance. */
export const ACTIVITY_SCENE_BY_STATE = {
	working: "mobius",
	composing: "mobius",
	searching: "wave",
	shaping: "helix",
	solving: "donut",
	listening: "dither",
	delegating: "vortex",
} as const satisfies Record<AgentActivityState, ActivityLoaderScene>;

/** Project wrapper for agent-only activity. */
export function AgentActivityOrb({
	state = "working",
	label,
	size = "compact",
	className,
}: AgentActivityOrbProps): React.ReactElement {
	return (
		<ActivityLoader
			scene={ACTIVITY_SCENE_BY_STATE[state]}
			size={PIXELS_BY_SIZE[size]}
			label={label}
			className={className}
		/>
	);
}
