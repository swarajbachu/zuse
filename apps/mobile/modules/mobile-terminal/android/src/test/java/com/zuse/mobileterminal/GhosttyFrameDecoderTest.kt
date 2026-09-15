package com.zuse.mobileterminal

import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class GhosttyFrameDecoderTest {
  @Test
  fun decodesAStyledUnicodeFrame() {
    val frame = GhosttyFrameDecoder.decode(
      frameBytes(
        columns = 2,
        rows = 1,
        cells = listOf("λ", "🙂")
      )
    )

    requireNotNull(frame)
    assertEquals(2, frame.columns)
    assertEquals("λ", frame.cell(0, 0)?.text)
    assertEquals("🙂", frame.cell(1, 0)?.text)
    assertEquals("λ🙂", frame.accessibleText())
  }

  @Test
  fun rejectsTruncatedOrDimensionallyInconsistentFrames() {
    val valid = frameBytes(columns = 1, rows = 1, cells = listOf("x"))
    assertNull(GhosttyFrameDecoder.decode(valid.copyOf(valid.size - 1)))
    assertNull(GhosttyFrameDecoder.decode(frameBytes(columns = 2, rows = 1, cells = listOf("x"))))
  }

  private fun frameBytes(columns: Int, rows: Int, cells: List<String>): ByteArray {
    val output = ByteArrayOutputStream()
    output.write(byteArrayOf('Z'.code.toByte(), 'V'.code.toByte(), 'T'.code.toByte(), '1'.code.toByte()))
    output.writeLittleEndianShort(columns)
    output.writeLittleEndianShort(rows)
    output.writeLittleEndianShort(0)
    output.writeLittleEndianShort(0)
    output.write(1)
    output.write(1)
    repeat(3) { output.write(byteArrayOf(17, 17, 17)) }
    output.writeLittleEndianInt(cells.size)
    for (cell in cells) {
      val bytes = cell.encodeToByteArray()
      output.writeLittleEndianShort(GhosttyCellFlags.BOLD)
      output.write(byteArrayOf(232.toByte(), 234.toByte(), 239.toByte()))
      output.write(byteArrayOf(17, 17, 17))
      output.writeLittleEndianShort(bytes.size)
      output.write(bytes)
    }
    return output.toByteArray()
  }

  private fun ByteArrayOutputStream.writeLittleEndianShort(value: Int) {
    write(ByteBuffer.allocate(2).order(ByteOrder.LITTLE_ENDIAN).putShort(value.toShort()).array())
  }

  private fun ByteArrayOutputStream.writeLittleEndianInt(value: Int) {
    write(ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array())
  }
}
