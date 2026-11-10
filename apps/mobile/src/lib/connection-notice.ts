import type { ConnectionSnapshot } from "@zuse/client-runtime/supervisor";

import { connectionErrorMessage } from "./connection-error-message";

/** Quick socket swaps (resume, new route) finish before anything is shown. */
export const CONNECTION_NOTICE_DELAY_MS = 1_200;
/** Once shown, a notice stays long enough to read instead of flickering. */
export const CONNECTION_NOTICE_MIN_VISIBLE_MS = 600;
/**
 * Failed attempts before the copy asks the user to check the computer. With
 * the 1s, 2s, 4s, 8s backoff this is roughly 15 seconds of failures, so a
 * brief blip never reads as the computer being unreachable.
 */
const PERSISTENT_FAILURE_ATTEMPTS = 5;

export type ConnectionNotice = {
	/** `progress` waits out the grace period; `problem` needs the user now. */
	readonly tone: "progress" | "problem";
	readonly title: string;
	readonly detail: string | null;
	readonly canRetry: boolean;
	readonly canPairAgain: boolean;
};

/**
 * One wording for every connection surface. "Reconnecting" is reserved for
 * a real failed attempt; replacing a healthy socket reads as "Connecting".
 */
export const connectionNotice = (
	snapshot: ConnectionSnapshot | undefined,
	label: string,
): ConnectionNotice | null => {
	switch (snapshot?.status) {
		case undefined:
		case "connected":
			return null;
		case "offline":
			return {
				tone: "progress",
				title: "Offline",
				detail: "Waiting for a network connection",
				canRetry: true,
				canPairAgain: false,
			};
		case "blockedAuth":
			return {
				tone: "problem",
				title: "Sign in required",
				detail: connectionErrorMessage(snapshot.error ?? "Sign in again"),
				canRetry: true,
				canPairAgain: true,
			};
		case "error":
			return {
				tone: "problem",
				title: `Can’t reach ${label}`,
				detail:
					snapshot.error === null
						? "Check that it’s awake and online."
						: connectionErrorMessage(snapshot.error),
				canRetry: true,
				canPairAgain: true,
			};
		case "connecting":
		case "reconnecting": {
			if (snapshot.attempt === 0 && snapshot.error === null)
				return {
					tone: "progress",
					title: `Connecting to ${label}…`,
					detail: null,
					canRetry: false,
					canPairAgain: false,
				};
			if (snapshot.attempt < PERSISTENT_FAILURE_ATTEMPTS)
				return {
					tone: "progress",
					title: `Reconnecting to ${label}…`,
					detail: null,
					canRetry: false,
					canPairAgain: false,
				};
			return {
				tone: "progress",
				title: `Can’t reach ${label}`,
				detail: "Still trying. Check that it’s awake and online.",
				canRetry: true,
				canPairAgain: true,
			};
		}
	}
};

/** A failure outside one supervised socket, such as loading the computer list. */
export const connectionProblemNotice = (cause: unknown): ConnectionNotice => ({
	tone: "problem",
	title: "Connection issue",
	detail: connectionErrorMessage(cause),
	canRetry: true,
	canPairAgain: true,
});
