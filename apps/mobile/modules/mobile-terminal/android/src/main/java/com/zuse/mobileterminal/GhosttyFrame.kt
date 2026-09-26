package com.zuse.mobileterminal

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets

internal object GhosttyCellFlags {
  const val SELECTED = 1
  const val BOLD = 1 shl 1
  const val ITALIC = 1 shl 2
  const val FAINT = 1 shl 3
  const val UNDERLINE = 1 shl 4
  const val STRIKETHROUGH = 1 shl 5
  const val OVERLINE = 1 shl 6
  const val INVISIBLE = 1 shl 7
  const val BLINK = 1 shl 8
}

internal data class GhosttyCell(
  val text: String,
  val foreground: Int,
  val background: Int,
  val flags: Int
)

internal data class GhosttyFrame(
  val columns: Int,
  val rows: Int,
  val cursorColumn: Int,
  val cursorRow: Int,
  val cursorStyle: Int,
  val cursorVisible: Boolean,
  val cursorBlinking: Boolean,
  val background: Int,
  val foreground: Int,
  val cursorColor: Int,
  val cells: List<GhosttyCell>
) {
  fun cell(column: Int, row: Int): GhosttyCell? {
    if (column !in 0 until columns || row !in 0 until rows) return null
    return cells.getOrNull(row * columns + column)
  }

  fun accessibleText(): String = buildString {
    for (row in 0 until rows) {
      if (row > 0) append('\n')
      for (column in 0 until columns) append(cell(column, row)?.text.orEmpty())
    }
  }.trimEnd()
}

internal object GhosttyFrameDecoder {
  private const val HEADER_SIZE = 27
  private const val MAX_DIMENSION = 1_000
  private const val MAX_FRAME_BYTES = 16 * 1024 * 1024
  private const val MAX_GRAPHEME_BYTES = 4_096

  fun decode(bytes: ByteArray): GhosttyFrame? {
    if (bytes.size !in HEADER_SIZE..MAX_FRAME_BYTES) return null
    val input = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
    if (
      input.get().toInt() != 'Z'.code ||
      input.get().toInt() != 'V'.code ||
      input.get().toInt() != 'T'.code ||
      input.get().toInt() != '1'.code
    ) return null

    val columns = input.short.toInt() and 0xffff
    val rows = input.short.toInt() and 0xffff
    if (columns !in 1..MAX_DIMENSION || rows !in 1..MAX_DIMENSION) return null
    val cursorColumn = input.short.toInt()
    val cursorRow = input.short.toInt()
    val cursorStyle = input.get().toInt() and 0xff
    val cursorFlags = input.get().toInt() and 0xff
    val background = input.readColor()
    val foreground = input.readColor()
    val cursorColor = input.readColor()
    val cellCount = input.int
    if (cellCount != columns * rows) return null

    val cells = ArrayList<GhosttyCell>(cellCount)
    repeat(cellCount) {
      if (input.remaining() < 10) return null
      val flags = input.short.toInt() and 0xffff
      val cellForeground = input.readColor()
      val cellBackground = input.readColor()
      val length = input.short.toInt() and 0xffff
      if (length > MAX_GRAPHEME_BYTES || length > input.remaining()) return null
      val textBytes = ByteArray(length)
      input.get(textBytes)
      cells.add(
        GhosttyCell(
          text = String(textBytes, StandardCharsets.UTF_8),
          foreground = cellForeground,
          background = cellBackground,
          flags = flags
        )
      )
    }
    if (input.hasRemaining()) return null

    return GhosttyFrame(
      columns = columns,
      rows = rows,
      cursorColumn = cursorColumn,
      cursorRow = cursorRow,
      cursorStyle = cursorStyle,
      cursorVisible = cursorFlags and 1 != 0,
      cursorBlinking = cursorFlags and 2 != 0,
      background = background,
      foreground = foreground,
      cursorColor = cursorColor,
      cells = cells
    )
  }

  private fun ByteBuffer.readColor(): Int {
    val red = get().toInt() and 0xff
    val green = get().toInt() and 0xff
    val blue = get().toInt() and 0xff
    return (0xff shl 24) or (red shl 16) or (green shl 8) or blue
  }
}
