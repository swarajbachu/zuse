import type { SessionStatus } from "@zuse/contracts";

import { PresenceDot, type PresenceTone } from "./presence-dot";

const toneFor = (
	status?: SessionStatus,
): { tone: PresenceTone; pulse: boolean } => {
	switch (status) {
		case "booting":
			return { tone: "checking", pulse: true };
		case "running":
			return { tone: "online", pulse: false };
		case "error":
			return { tone: "error", pulse: false };
		default:
			return { tone: "offline", pulse: false };
	}
};

export const StatusDot = ({ status }: { status?: SessionStatus }) => {
	const { tone, pulse } = toneFor(status);
	return <PresenceDot tone={tone} pulse={pulse} />;
};
