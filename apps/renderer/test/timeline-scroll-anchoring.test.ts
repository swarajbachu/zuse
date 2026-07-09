import { describe, expect, it } from "bun:test";

import {
  getAnchoredTurnMetrics,
  getRowBottom,
  resolveScrollableNodeIsAtEnd,
  shouldDeferAutomaticEndScroll,
  shouldRestoreAnchorScrollOffset,
} from "../src/lib/timeline-scroll-anchoring.ts";

function buildState({
  positions,
  sizes,
  scroll = 0,
  scrollLength = 700,
}: {
  readonly positions: readonly number[];
  readonly sizes: readonly number[];
  readonly scroll?: number;
  readonly scrollLength?: number;
}) {
  return {
    data: positions.map((_, index) => index),
    scroll,
    scrollLength,
    positionAtIndex: (index: number) => positions[index],
    sizeAtIndex: (index: number) => sizes[index],
  };
}

describe("timeline scroll anchoring", () => {
  it("measures row bottoms from row position and size", () => {
    const state = buildState({
      positions: [0, 120],
      sizes: [80, 40],
    });

    expect(getRowBottom(state, 1)).toBe(160);
  });

  it("treats the active turn as fitting when it fits above the composer", () => {
    const state = buildState({
      positions: [0, 300, 460],
      sizes: [240, 80, 140],
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(300);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(false);
    expect(metrics?.targetScrollToRevealEnd).toBe(36);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(36);
  });

  it("targets the real row end instead of reserved tail space", () => {
    const state = buildState({
      positions: [0, 1720, 1880],
      sizes: [1600, 80, 120],
      scroll: 1900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(2000);
    expect(metrics?.targetScrollToRevealEnd).toBe(1436);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(0);
  });

  it("reports overflow only for the current anchored turn", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 300],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.turnHeight).toBe(580);
    expect(metrics?.usableViewportHeight).toBe(564);
    expect(metrics?.overflowsUsableViewport).toBe(true);
  });

  it("returns the minimal positive scroll delta needed to reveal the turn end", () => {
    const state = buildState({
      positions: [0, 900, 1180],
      sizes: [800, 220, 360],
      scroll: 900,
      scrollLength: 760,
    });

    const metrics = getAnchoredTurnMetrics({
      state,
      anchorIndex: 1,
      composerOverlayHeight: 180,
      anchorOffset: 16,
    });

    expect(metrics?.lastBottom).toBe(1540);
    expect(metrics?.visibleUsableBottom).toBe(1464);
    expect(metrics?.scrollDeltaToRevealEnd).toBe(76);
  });

  it("defers automatic end-follow while an anchor is pending or settling", () => {
    expect(
      shouldDeferAutomaticEndScroll({
        pendingAnchorId: "u1",
        positionedAnchorId: null,
        settledAnchorId: null,
      }),
    ).toBe(true);

    expect(
      shouldDeferAutomaticEndScroll({
        pendingAnchorId: null,
        positionedAnchorId: "u1",
        settledAnchorId: null,
      }),
    ).toBe(true);

    expect(
      shouldDeferAutomaticEndScroll({
        pendingAnchorId: null,
        positionedAnchorId: "u1",
        settledAnchorId: "u1",
      }),
    ).toBe(false);
  });

  it("preserves an anchored offset only while the same settled anchor is stable", () => {
    expect(
      shouldRestoreAnchorScrollOffset({
        anchorId: "u1",
        settledAnchorId: "u1",
        expectedOffset: 320,
        currentOffset: 321.5,
        expectedUserNavigationGeneration: 2,
        currentUserNavigationGeneration: 2,
      }),
    ).toBe(true);

    expect(
      shouldRestoreAnchorScrollOffset({
        anchorId: "u1",
        settledAnchorId: "u2",
        expectedOffset: 320,
        currentOffset: 321,
        expectedUserNavigationGeneration: 2,
        currentUserNavigationGeneration: 2,
      }),
    ).toBe(false);

    expect(
      shouldRestoreAnchorScrollOffset({
        anchorId: "u1",
        settledAnchorId: "u1",
        expectedOffset: 320,
        currentOffset: 326,
        expectedUserNavigationGeneration: 2,
        currentUserNavigationGeneration: 2,
      }),
    ).toBe(false);

    expect(
      shouldRestoreAnchorScrollOffset({
        anchorId: "u1",
        settledAnchorId: "u1",
        expectedOffset: 320,
        currentOffset: 321,
        expectedUserNavigationGeneration: 2,
        currentUserNavigationGeneration: 3,
      }),
    ).toBe(false);
  });

  it("detects whether the actual scroll node has left the live edge", () => {
    // 20px from bottom — still at the live edge.
    expect(
      resolveScrollableNodeIsAtEnd({
        scrollTop: 960,
        scrollHeight: 1400,
        clientHeight: 420,
      }),
    ).toBe(true);

    // 160px from bottom — within the near-edge band, still at end.
    expect(
      resolveScrollableNodeIsAtEnd({
        scrollTop: 820,
        scrollHeight: 1400,
        clientHeight: 420,
      }),
    ).toBe(true);

    // 280px from bottom — meaningfully scrolled away.
    expect(
      resolveScrollableNodeIsAtEnd({
        scrollTop: 700,
        scrollHeight: 1400,
        clientHeight: 420,
      }),
    ).toBe(false);

    expect(resolveScrollableNodeIsAtEnd(null)).toBeUndefined();
  });
});
