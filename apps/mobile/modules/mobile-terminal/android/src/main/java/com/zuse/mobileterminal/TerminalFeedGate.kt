package com.zuse.mobileterminal

import java.nio.charset.StandardCharsets

/** Rejects duplicate and out-of-order React props without retaining transcript bytes. */
internal class TerminalFeedGate {
  private var latestSequence = -1L

  fun reset() {
    latestSequence = -1L
  }

  fun accept(value: String?): ByteArray? {
    if (value == null) {
      reset()
      return null
    }
    val separator = value.indexOf('\u0000')
    if (separator <= 0) return null
    val sequence = value.substring(0, separator).toLongOrNull() ?: return null
    if (sequence <= latestSequence) return null
    latestSequence = sequence
    return value.substring(separator + 1).toByteArray(StandardCharsets.UTF_8)
  }
}
