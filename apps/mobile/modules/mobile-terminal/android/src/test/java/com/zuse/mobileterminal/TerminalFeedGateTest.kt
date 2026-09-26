package com.zuse.mobileterminal

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalFeedGateTest {
  @Test
  fun acceptsOnlyStrictlyIncreasingFeedSequences() {
    val gate = TerminalFeedGate()

    assertArrayEquals("first".encodeToByteArray(), gate.accept("1\u0000first"))
    assertNull(gate.accept("1\u0000duplicate"))
    assertNull(gate.accept("0\u0000old"))
    assertArrayEquals("third".encodeToByteArray(), gate.accept("3\u0000third"))
  }

  @Test
  fun nullFeedResetsTheSequenceForATerminalSwitch() {
    val gate = TerminalFeedGate()
    assertArrayEquals("old".encodeToByteArray(), gate.accept("7\u0000old"))

    assertNull(gate.accept(null))

    assertArrayEquals("new".encodeToByteArray(), gate.accept("1\u0000new"))
  }
}
