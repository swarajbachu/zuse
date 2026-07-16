/** Non-iOS fallback: native menu unavailable, renders nothing (iOS-first). */
export function ComposerPlusMenu(_props: {
	planMode: boolean;
	onTogglePlan: (next: boolean) => void;
}) {
	return null;
}
