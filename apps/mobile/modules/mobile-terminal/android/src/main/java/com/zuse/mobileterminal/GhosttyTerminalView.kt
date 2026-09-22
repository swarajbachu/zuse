package com.zuse.mobileterminal

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Bundle
import android.os.SystemClock
import android.text.InputType
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.core.content.getSystemService
import java.nio.charset.StandardCharsets
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max

@SuppressLint("ViewConstructor")
internal class GhosttyTerminalView @JvmOverloads constructor(
  context: Context,
  private val emitInput: (String) -> Unit,
  private val emitResize: (Int, Int) -> Unit,
  private val onOpenLink: (String) -> Unit,
  attrs: AttributeSet? = null
) : View(context, attrs) {
  private val feedGate = TerminalFeedGate()
  private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG)
  private val decorationPaint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val gestureDetector = GestureDetector(context, TerminalGestureListener())
  private val regularTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.NORMAL)
  private val boldTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
  private val italicTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.ITALIC)
  private val boldItalicTypeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD_ITALIC)
  private var handle = 0L
  private var currentFrame: GhosttyFrame? = null
  private var fontSizeSp = 12f
  private var cellWidth = 8
  private var cellHeight = 16
  private var baselineOffset = 13f
  private var latestFocusNonce = -1
  private var latestControlNonce = -1
  private var controlArmed = false
  private var lastColumns = 80
  private var lastRows = 24
  private var selectionAnchor: Pair<Int, Int>? = null
  private var mouseCaptured = false
  private var pointerCapturedButton = MOUSE_BUTTON_UNKNOWN
  private var scrollRemainder = 0f
  private var composingText = ""
  private var disposed = false
  private var blinkInvalidationScheduled = false
  private val blinkInvalidator = Runnable {
    blinkInvalidationScheduled = false
    if (!disposed) invalidate()
  }

  init {
    setBackgroundColor(0xff111111.toInt())
    isFocusable = true
    isFocusableInTouchMode = true
    isClickable = true
    importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_YES
    contentDescription = "Terminal"
    updateTextMetrics()
    handle = GhosttyTerminalNative.create(lastColumns, lastRows, cellWidth, cellHeight)
  }

  fun feed(value: String?) {
    val bytes = feedGate.accept(value) ?: return
    withHandle { terminal ->
      emitNativeBytes(GhosttyTerminalNative.feed(terminal, bytes))
      emitNativeBytes(
        GhosttyTerminalNative.encodeFocus(terminal, hasFocus() && hasWindowFocus())
      )
      currentFrame = null
      postInvalidateOnAnimation()
    }
  }

  fun setTerminalFontSize(value: Double?) {
    val clamped = (value ?: 12.0).coerceIn(9.0, 24.0).toFloat()
    if (clamped == fontSizeSp) return
    fontSizeSp = clamped
    updateTextMetrics()
    resizeForBounds()
    invalidate()
  }

  fun focusForNonce(nonce: Int?) {
    if (nonce == null || nonce == latestFocusNonce) return
    latestFocusNonce = nonce
    post { requestTerminalFocus() }
  }

  fun armControlForNonce(nonce: Int?) {
    if (nonce == null || nonce == latestControlNonce) return
    val wasUninitialized = latestControlNonce == -1
    latestControlNonce = nonce
    if (wasUninitialized && nonce == 0) return
    controlArmed = true
    post { requestTerminalFocus() }
  }

  fun dispose() {
    if (disposed) return
    disposed = true
    val terminal = handle
    handle = 0L
    if (terminal != 0L) GhosttyTerminalNative.destroy(terminal)
    removeCallbacks(blinkInvalidator)
    blinkInvalidationScheduled = false
    currentFrame = null
  }

  override fun onSizeChanged(width: Int, height: Int, oldWidth: Int, oldHeight: Int) {
    super.onSizeChanged(width, height, oldWidth, oldHeight)
    resizeForBounds()
  }

  override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
    super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
    withHandle {
      emitNativeBytes(GhosttyTerminalNative.encodeFocus(it, gainFocus && hasWindowFocus()))
    }
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    withHandle {
      emitNativeBytes(GhosttyTerminalNative.encodeFocus(it, hasWindowFocus && hasFocus()))
    }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    val frame = currentFrame
      ?: withHandleResult { GhosttyFrameDecoder.decode(GhosttyTerminalNative.render(it)) }
    if (frame == null) {
      canvas.drawColor(0xff111111.toInt())
      return
    }
    currentFrame = frame
    drawFrame(canvas, frame)
    val semanticText = frame.accessibleText()
    val nextDescription = if (semanticText.isEmpty()) "Terminal" else "Terminal\n$semanticText"
    if (contentDescription != nextDescription) contentDescription = nextDescription
    if (frame.cursorBlinking || frame.cells.any { it.flags and GhosttyCellFlags.BLINK != 0 }) {
      scheduleBlinkInvalidation()
    } else if (blinkInvalidationScheduled) {
      removeCallbacks(blinkInvalidator)
      blinkInvalidationScheduled = false
    }
  }

  override fun onCheckIsTextEditor(): Boolean = true

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
    outAttrs.inputType =
      InputType.TYPE_CLASS_TEXT or
        InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
        InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
    return TerminalInputConnection()
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
      return super.onKeyDown(keyCode, event)
    }
    return sendHardwareKey(keyCode, event)
  }

  override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
      return super.onKeyUp(keyCode, event)
    }
    return sendHardwareKey(keyCode, event)
  }

  @Suppress("DEPRECATION")
  override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
    val characters = event.characters
    if (!characters.isNullOrEmpty()) {
      emitText(characters)
      return true
    }
    return super.onKeyMultiple(keyCode, repeatCount, event)
  }

  // GestureDetector dispatches real taps through onSingleTapConfirmed, which calls performClick.
  @SuppressLint("ClickableViewAccessibility")
  override fun onTouchEvent(event: MotionEvent): Boolean {
    if (mouseCaptured) {
      when (event.actionMasked) {
        MotionEvent.ACTION_MOVE -> {
          sendMouse(event, MOUSE_ACTION_MOTION, MOUSE_BUTTON_LEFT)
          return true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          sendMouse(event, MOUSE_ACTION_RELEASE, MOUSE_BUTTON_LEFT)
          mouseCaptured = false
          return true
        }
      }
    }
    val handled = gestureDetector.onTouchEvent(event)
    if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
      if (selectionAnchor != null && event.actionMasked == MotionEvent.ACTION_UP) copySelection()
      selectionAnchor = null
      scrollRemainder = 0f
    }
    return handled || super.onTouchEvent(event)
  }

  override fun onHoverEvent(event: MotionEvent): Boolean {
    if (event.source and InputDevice.SOURCE_CLASS_POINTER != 0) {
      val button = pointerButton(event.buttonState)
      if (sendMouse(event, MOUSE_ACTION_MOTION, button)) return true
    }
    return super.onHoverEvent(event)
  }

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    if (event.source and InputDevice.SOURCE_CLASS_POINTER == 0) {
      return super.onGenericMotionEvent(event)
    }
    when (event.actionMasked) {
      MotionEvent.ACTION_BUTTON_PRESS -> {
        if (event.metaState and KeyEvent.META_SHIFT_ON != 0) {
          return super.onGenericMotionEvent(event)
        }
        val button = pointerButton(
          event.actionButton.takeIf { it != 0 } ?: event.buttonState
        )
        if (button != MOUSE_BUTTON_UNKNOWN && sendMouse(event, MOUSE_ACTION_PRESS, button)) {
          pointerCapturedButton = button
          return true
        }
      }
      MotionEvent.ACTION_BUTTON_RELEASE -> {
        val capturedButton = pointerCapturedButton
        val button = pointerButton(event.actionButton).takeIf {
          it != MOUSE_BUTTON_UNKNOWN
        } ?: capturedButton
        val sent = button != MOUSE_BUTTON_UNKNOWN &&
          sendMouse(event, MOUSE_ACTION_RELEASE, button)
        pointerCapturedButton = MOUSE_BUTTON_UNKNOWN
        if (sent || capturedButton != MOUSE_BUTTON_UNKNOWN) return true
      }
      MotionEvent.ACTION_HOVER_MOVE, MotionEvent.ACTION_MOVE -> {
        val button = pointerButton(event.buttonState).takeIf {
          it != MOUSE_BUTTON_UNKNOWN
        } ?: pointerCapturedButton
        if (sendMouse(event, MOUSE_ACTION_MOTION, button)) return true
      }
      MotionEvent.ACTION_SCROLL -> {
        val vertical = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
        if (vertical != 0f && event.metaState and KeyEvent.META_SHIFT_ON == 0) {
          val button = if (vertical > 0f) MOUSE_BUTTON_WHEEL_UP else MOUSE_BUTTON_WHEEL_DOWN
          if (sendMouse(event, MOUSE_ACTION_PRESS, button)) return true
        }
        if (vertical != 0f) {
          val rows = if (vertical > 0f) -3 else 3
          withHandle { GhosttyTerminalNative.scroll(it, rows) }
          currentFrame = null
          postInvalidateOnAnimation()
          return true
        }
      }
    }
    return super.onGenericMotionEvent(event)
  }

  override fun performClick(): Boolean {
    super.performClick()
    requestTerminalFocus()
    return true
  }

  override fun onInitializeAccessibilityNodeInfo(info: android.view.accessibility.AccessibilityNodeInfo) {
    super.onInitializeAccessibilityNodeInfo(info)
    info.className = "android.widget.EditText"
    info.isEditable = true
    info.addAction(android.view.accessibility.AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK)
  }

  override fun performAccessibilityAction(action: Int, arguments: Bundle?): Boolean {
    if (action == android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK) {
      requestTerminalFocus()
      return true
    }
    return super.performAccessibilityAction(action, arguments)
  }

  private fun drawFrame(canvas: Canvas, frame: GhosttyFrame) {
    canvas.drawColor(frame.background)
    val blinkOn = (SystemClock.uptimeMillis() / 500L) % 2L == 0L
    val selectionBackground = 0xff315e9f.toInt()
    val selectionForeground = Color.WHITE

    for (row in 0 until frame.rows) {
      val top = row * cellHeight.toFloat()
      val baseline = top + baselineOffset
      for (column in 0 until frame.columns) {
        val cell = frame.cell(column, row) ?: continue
        val left = column * cellWidth.toFloat()
        val selected = cell.flags and GhosttyCellFlags.SELECTED != 0
        val background = if (selected) selectionBackground else cell.background
        if (background != frame.background) {
          decorationPaint.color = background
          canvas.drawRect(left, top, left + cellWidth, top + cellHeight, decorationPaint)
        }

        val hidden = cell.flags and GhosttyCellFlags.INVISIBLE != 0
        val blinking = cell.flags and GhosttyCellFlags.BLINK != 0
        if (cell.text.isNotEmpty() && !hidden && (!blinking || blinkOn)) {
          val bold = cell.flags and GhosttyCellFlags.BOLD != 0
          val italic = cell.flags and GhosttyCellFlags.ITALIC != 0
          textPaint.typeface = when {
            bold && italic -> boldItalicTypeface
            bold -> boldTypeface
            italic -> italicTypeface
            else -> regularTypeface
          }
          textPaint.color = if (selected) selectionForeground else cell.foreground
          textPaint.alpha = if (cell.flags and GhosttyCellFlags.FAINT != 0) 160 else 255
          canvas.drawText(cell.text, left, baseline, textPaint)
          textPaint.alpha = 255
        }

        decorationPaint.color = if (selected) selectionForeground else cell.foreground
        decorationPaint.strokeWidth = max(1f, resources.displayMetrics.density)
        if (cell.flags and GhosttyCellFlags.UNDERLINE != 0) {
          canvas.drawLine(left, top + cellHeight - 2f, left + cellWidth, top + cellHeight - 2f, decorationPaint)
        }
        if (cell.flags and GhosttyCellFlags.STRIKETHROUGH != 0) {
          canvas.drawLine(left, top + cellHeight * 0.52f, left + cellWidth, top + cellHeight * 0.52f, decorationPaint)
        }
        if (cell.flags and GhosttyCellFlags.OVERLINE != 0) {
          canvas.drawLine(left, top + 1f, left + cellWidth, top + 1f, decorationPaint)
        }
      }
    }

    if (frame.cursorVisible && (!frame.cursorBlinking || blinkOn)) drawCursor(canvas, frame)
    if (composingText.isNotEmpty()) drawPreedit(canvas, frame)
  }

  private fun drawCursor(canvas: Canvas, frame: GhosttyFrame) {
    if (frame.cursorColumn !in 0 until frame.columns || frame.cursorRow !in 0 until frame.rows) return
    val left = frame.cursorColumn * cellWidth.toFloat()
    val top = frame.cursorRow * cellHeight.toFloat()
    decorationPaint.color = frame.cursorColor
    decorationPaint.style = Paint.Style.FILL
    when (frame.cursorStyle) {
      0 -> canvas.drawRect(left, top, left + max(2f, cellWidth * 0.16f), top + cellHeight, decorationPaint)
      2 -> canvas.drawRect(left, top + cellHeight - max(2f, cellHeight * 0.14f), left + cellWidth, top + cellHeight, decorationPaint)
      3 -> {
        decorationPaint.style = Paint.Style.STROKE
        decorationPaint.strokeWidth = max(1f, resources.displayMetrics.density)
        canvas.drawRect(left, top, left + cellWidth, top + cellHeight, decorationPaint)
        decorationPaint.style = Paint.Style.FILL
      }
      else -> {
        decorationPaint.alpha = 112
        canvas.drawRect(left, top, left + cellWidth, top + cellHeight, decorationPaint)
        decorationPaint.alpha = 255
      }
    }
  }

  private fun drawPreedit(canvas: Canvas, frame: GhosttyFrame) {
    if (frame.cursorColumn !in 0 until frame.columns || frame.cursorRow !in 0 until frame.rows) return
    val left = frame.cursorColumn * cellWidth.toFloat()
    val top = frame.cursorRow * cellHeight.toFloat()
    textPaint.typeface = regularTypeface
    textPaint.color = frame.foreground
    canvas.drawText(composingText, left, top + baselineOffset, textPaint)
    decorationPaint.color = frame.foreground
    canvas.drawLine(left, top + cellHeight - 1f, left + textPaint.measureText(composingText), top + cellHeight - 1f, decorationPaint)
  }

  private fun updateTextMetrics() {
    textPaint.textSize =
      fontSizeSp * resources.displayMetrics.density * resources.configuration.fontScale
    textPaint.typeface = regularTypeface
    val metrics = textPaint.fontMetrics
    cellWidth = max(1, ceil(textPaint.measureText("M").toDouble()).toInt())
    cellHeight = max(1, ceil((metrics.descent - metrics.ascent + metrics.leading).toDouble()).toInt())
    baselineOffset = -metrics.ascent
  }

  private fun resizeForBounds() {
    if (width <= 0 || height <= 0) return
    val columns = max(1, floor(width.toDouble() / cellWidth).toInt()).coerceAtMost(1_000)
    val rows = max(1, floor(height.toDouble() / cellHeight).toInt()).coerceAtMost(1_000)
    if (columns == lastColumns && rows == lastRows) return
    lastColumns = columns
    lastRows = rows
    withHandle { terminal ->
      emitNativeBytes(GhosttyTerminalNative.resize(terminal, columns, rows, cellWidth, cellHeight))
      currentFrame = null
    }
    emitResize(columns, rows)
  }

  private fun requestTerminalFocus() {
    requestFocus()
    context.getSystemService<InputMethodManager>()?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
  }

  private fun scheduleBlinkInvalidation() {
    if (blinkInvalidationScheduled) return
    blinkInvalidationScheduled = true
    postDelayed(blinkInvalidator, 500L)
  }

  private fun emitText(text: String) {
    if (text.isEmpty()) return
    if (controlArmed) {
      val firstCodePoint = text.codePointAt(0)
      val firstLength = Character.charCount(firstCodePoint)
      sendEncodedKey(KeyEvent.KEYCODE_UNKNOWN, firstCodePoint, text.substring(0, firstLength), MOD_CTRL)
      if (firstLength < text.length) emitInput(text.substring(firstLength))
      controlArmed = false
      return
    }
    emitInput(text)
  }

  private fun sendHardwareKey(keyCode: Int, event: KeyEvent): Boolean {
    val codePoint = event.unicodeChar
    val text = if (codePoint > 0 && !Character.isISOControl(codePoint)) String(Character.toChars(codePoint)) else null
    val modifiers =
      (if (event.isShiftPressed) MOD_SHIFT else 0) or
        (if (event.isCtrlPressed || controlArmed) MOD_CTRL else 0) or
        (if (event.isAltPressed) MOD_ALT else 0) or
        (if (event.isMetaPressed) MOD_SUPER else 0) or
        (if (event.isCapsLockOn) MOD_CAPS_LOCK else 0) or
        (if (event.isNumLockOn) MOD_NUM_LOCK else 0)
    val action = when {
      event.action == KeyEvent.ACTION_UP -> KEY_ACTION_RELEASE
      event.repeatCount > 0 -> KEY_ACTION_REPEAT
      else -> KEY_ACTION_PRESS
    }
    val sent = sendEncodedKey(keyCode, codePoint, text, modifiers, action)
    if (sent) controlArmed = false
    return sent
  }

  private fun sendEncodedKey(
    keyCode: Int,
    codePoint: Int,
    text: String?,
    modifiers: Int,
    action: Int = KEY_ACTION_PRESS
  ): Boolean {
    val bytes = withHandleResult {
      GhosttyTerminalNative.encodeKey(it, keyCode, codePoint, text, modifiers, action)
    } ?: return false
    if (bytes.isEmpty()) return false
    emitNativeBytes(bytes)
    return true
  }

  private fun emitNativeBytes(bytes: ByteArray) {
    if (bytes.isEmpty()) return
    emitInput(String(bytes, StandardCharsets.UTF_8))
  }

  private fun sendMouse(event: MotionEvent, action: Int, button: Int): Boolean {
    val modifiers =
      (if (event.metaState and KeyEvent.META_SHIFT_ON != 0) MOD_SHIFT else 0) or
        (if (event.metaState and KeyEvent.META_CTRL_ON != 0) MOD_CTRL else 0) or
        (if (event.metaState and KeyEvent.META_ALT_ON != 0) MOD_ALT else 0) or
        (if (event.metaState and KeyEvent.META_META_ON != 0) MOD_SUPER else 0) or
        (if (event.metaState and KeyEvent.META_CAPS_LOCK_ON != 0) MOD_CAPS_LOCK else 0) or
        (if (event.metaState and KeyEvent.META_NUM_LOCK_ON != 0) MOD_NUM_LOCK else 0)
    val bytes = withHandleResult {
      GhosttyTerminalNative.encodeMouse(
        it,
        action,
        button,
        modifiers,
        event.x,
        event.y,
        max(1, width),
        max(1, height),
        cellWidth,
        cellHeight
      )
    } ?: return false
    if (bytes.isEmpty()) return false
    emitNativeBytes(bytes)
    return true
  }

  private fun pointerButton(buttonState: Int): Int = when {
    buttonState and MotionEvent.BUTTON_PRIMARY != 0 -> MOUSE_BUTTON_LEFT
    buttonState and MotionEvent.BUTTON_SECONDARY != 0 -> MOUSE_BUTTON_RIGHT
    buttonState and MotionEvent.BUTTON_TERTIARY != 0 -> MOUSE_BUTTON_MIDDLE
    else -> MOUSE_BUTTON_UNKNOWN
  }

  private fun pointFor(event: MotionEvent): Pair<Int, Int> {
    val column = floor(event.x.toDouble() / cellWidth).toInt().coerceIn(0, max(0, lastColumns - 1))
    val row = floor(event.y.toDouble() / cellHeight).toInt().coerceIn(0, max(0, lastRows - 1))
    return column to row
  }

  private fun updateSelection(end: Pair<Int, Int>) {
    val start = selectionAnchor ?: return
    withHandle {
      if (GhosttyTerminalNative.select(it, start.first, start.second, end.first, end.second)) {
        currentFrame = null
        postInvalidateOnAnimation()
      }
    }
  }

  private fun copySelection() {
    val text = withHandleResult { GhosttyTerminalNative.selectedText(it) } ?: return
    if (text.isEmpty()) return
    context.getSystemService<ClipboardManager>()?.setPrimaryClip(ClipData.newPlainText("Terminal selection", text))
  }

  private inline fun withHandle(block: (Long) -> Unit) {
    val terminal = handle
    if (!disposed && terminal != 0L) block(terminal)
  }

  private inline fun <T> withHandleResult(block: (Long) -> T): T? {
    val terminal = handle
    return if (!disposed && terminal != 0L) block(terminal) else null
  }

  private inner class TerminalInputConnection : BaseInputConnection(this@GhosttyTerminalView, false) {
    override fun performContextMenuAction(id: Int): Boolean {
      if (id != android.R.id.paste && id != android.R.id.pasteAsPlainText) {
        return super.performContextMenuAction(id)
      }
      val clipboard = context.getSystemService<ClipboardManager>() ?: return false
      val clip = clipboard.primaryClip ?: return false
      if (clip.itemCount == 0) return false
      val text = clip.getItemAt(0).coerceToText(context)?.toString() ?: return false
      composingText = ""
      val encoded = withHandleResult { GhosttyTerminalNative.encodePaste(it, text) } ?: return false
      emitNativeBytes(encoded)
      invalidate()
      return true
    }

    override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
      composingText = ""
      text?.toString()?.let(::emitText)
      invalidate()
      return true
    }

    override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
      composingText = text?.toString().orEmpty()
      invalidate()
      return true
    }

    override fun finishComposingText(): Boolean {
      val text = composingText
      composingText = ""
      if (text.isNotEmpty()) emitText(text)
      invalidate()
      return true
    }

    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
      if (composingText.isNotEmpty()) {
        composingText = composingText.dropLast(minOf(beforeLength, composingText.length))
        invalidate()
        return true
      }
      sendDeleteKeys(KeyEvent.KEYCODE_DEL, beforeLength)
      sendDeleteKeys(KeyEvent.KEYCODE_FORWARD_DEL, afterLength)
      controlArmed = false
      return true
    }

    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int): Boolean =
      deleteSurroundingText(beforeLength, afterLength)

    override fun sendKeyEvent(event: KeyEvent): Boolean =
      if (event.action == KeyEvent.ACTION_DOWN) sendHardwareKey(event.keyCode, event) else true

    override fun performEditorAction(actionCode: Int): Boolean =
      sendEncodedKey(KeyEvent.KEYCODE_ENTER, '\n'.code, null, 0)
  }

  private fun sendDeleteKeys(keyCode: Int, count: Int) {
    repeat(count.coerceIn(0, 100)) { index ->
      sendEncodedKey(keyCode, 0, null, if (controlArmed && index == 0) MOD_CTRL else 0)
    }
  }

  private inner class TerminalGestureListener : GestureDetector.SimpleOnGestureListener() {
    override fun onDown(event: MotionEvent): Boolean {
      requestTerminalFocus()
      mouseCaptured =
        event.metaState and KeyEvent.META_SHIFT_ON == 0 &&
        sendMouse(event, MOUSE_ACTION_PRESS, MOUSE_BUTTON_LEFT)
      return true
    }

    override fun onSingleTapConfirmed(event: MotionEvent): Boolean {
      if (mouseCaptured) return true
      performClick()
      val point = pointFor(event)
      val link = withHandleResult { GhosttyTerminalNative.linkAt(it, point.first, point.second) }
      if (!link.isNullOrEmpty()) onOpenLink(link)
      return true
    }

    override fun onLongPress(event: MotionEvent) {
      if (mouseCaptured) return
      selectionAnchor = pointFor(event)
      updateSelection(selectionAnchor ?: return)
    }

    override fun onScroll(
      first: MotionEvent?,
      current: MotionEvent,
      distanceX: Float,
      distanceY: Float
    ): Boolean {
      if (selectionAnchor != null) {
        updateSelection(pointFor(current))
        return true
      }
      scrollRemainder += distanceY
      val rowDelta = (scrollRemainder / cellHeight).toInt()
      if (rowDelta != 0) {
        scrollRemainder -= rowDelta * cellHeight
        withHandle { GhosttyTerminalNative.scroll(it, rowDelta) }
        currentFrame = null
        postInvalidateOnAnimation()
      }
      return true
    }
  }

  companion object {
    private const val MOD_SHIFT = 1
    private const val MOD_CTRL = 1 shl 1
    private const val MOD_ALT = 1 shl 2
    private const val MOD_SUPER = 1 shl 3
    private const val MOD_CAPS_LOCK = 1 shl 4
    private const val MOD_NUM_LOCK = 1 shl 5
    private const val KEY_ACTION_RELEASE = 0
    private const val KEY_ACTION_PRESS = 1
    private const val KEY_ACTION_REPEAT = 2
    private const val MOUSE_ACTION_PRESS = 0
    private const val MOUSE_ACTION_RELEASE = 1
    private const val MOUSE_ACTION_MOTION = 2
    private const val MOUSE_BUTTON_UNKNOWN = 0
    private const val MOUSE_BUTTON_LEFT = 1
    private const val MOUSE_BUTTON_RIGHT = 2
    private const val MOUSE_BUTTON_MIDDLE = 3
    private const val MOUSE_BUTTON_WHEEL_UP = 4
    private const val MOUSE_BUTTON_WHEEL_DOWN = 5
  }
}
