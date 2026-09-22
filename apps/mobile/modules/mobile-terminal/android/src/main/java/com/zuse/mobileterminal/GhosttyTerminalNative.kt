package com.zuse.mobileterminal

import androidx.annotation.Keep

/** The only Kotlin/JNI seam for the pinned libghostty-vt implementation. */
@Keep
internal object GhosttyTerminalNative {
  init {
    System.loadLibrary("zuse-mobile-terminal")
  }

  @JvmStatic external fun create(cols: Int, rows: Int, cellWidth: Int, cellHeight: Int): Long
  @JvmStatic external fun destroy(handle: Long)
  @JvmStatic external fun feed(handle: Long, bytes: ByteArray): ByteArray
  @JvmStatic external fun resize(handle: Long, cols: Int, rows: Int, cellWidth: Int, cellHeight: Int): ByteArray
  @JvmStatic external fun render(handle: Long): ByteArray
  @JvmStatic external fun encodeKey(handle: Long, androidKeyCode: Int, codePoint: Int, text: String?, modifiers: Int, action: Int): ByteArray
  @JvmStatic external fun encodePaste(handle: Long, text: String): ByteArray
  @JvmStatic external fun encodeFocus(handle: Long, focused: Boolean): ByteArray
  @JvmStatic external fun encodeMouse(
    handle: Long,
    action: Int,
    button: Int,
    modifiers: Int,
    x: Float,
    y: Float,
    screenWidth: Int,
    screenHeight: Int,
    cellWidth: Int,
    cellHeight: Int
  ): ByteArray
  @JvmStatic external fun scroll(handle: Long, rows: Int)
  @JvmStatic external fun select(handle: Long, startColumn: Int, startRow: Int, endColumn: Int, endRow: Int): Boolean
  @JvmStatic external fun selectedText(handle: Long): String?
  @JvmStatic external fun linkAt(handle: Long, column: Int, row: Int): String?
  @JvmStatic external fun revision(): String
}
