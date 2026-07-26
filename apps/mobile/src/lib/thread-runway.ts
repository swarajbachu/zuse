const MINIMUM_RUNWAY = 16;
const VERTICAL_GUTTER = 24;

export const transcriptEndRunwayHeight = ({
	viewportHeight,
	headerHeight,
	composerHeight,
}: {
	readonly viewportHeight: number;
	readonly headerHeight: number;
	readonly composerHeight: number;
}): number =>
	Math.max(
		MINIMUM_RUNWAY,
		Math.round(
			viewportHeight - headerHeight - composerHeight - VERTICAL_GUTTER,
		),
	);
