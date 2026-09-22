/** Durable changes that invalidate the session catalog's summary. */
export const sessionSummaryEvents = new Set([
	"TurnStarted",
	"TurnSettled",
	"SessionTitleSet",
	"SessionModelSet",
	"SessionProviderSet",
	"SessionRuntimeModeSet",
	"SessionPermissionModeSet",
	"SessionWorktreeSet",
	"SessionStatusSet",
	"SessionResumeSet",
	"SessionArchived",
	"SessionUnarchived",
]);
