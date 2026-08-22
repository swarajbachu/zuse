const MINIMUM_RUNWAY = 16;

/**
 * The keyboard-aware list owns composer clearance and temporary send anchoring.
 * A settled transcript only needs a small visual gap after its final row.
 */
export const transcriptEndRunwayHeight = (): number => MINIMUM_RUNWAY;
