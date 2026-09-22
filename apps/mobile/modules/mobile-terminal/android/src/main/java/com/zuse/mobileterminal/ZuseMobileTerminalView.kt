package com.zuse.mobileterminal

import android.annotation.SuppressLint
import android.content.Context
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

@SuppressLint("ViewConstructor")
class ZuseMobileTerminalView(
  context: Context,
  appContext: AppContext
) : ExpoView(context, appContext) {
  private val terminalView = GhosttyTerminalView(context, ::emitInput, ::emitResize, ::emitLink)
  private val onInput by EventDispatcher<Map<String, String>>()
  private val onResize by EventDispatcher<Map<String, Int>>()
  private val onOpenLink by EventDispatcher<Map<String, String>>()

  init {
    setBackgroundColor(0xff111111.toInt())
    addView(
      terminalView,
      LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT)
    )
  }

  fun feed(value: String?) = terminalView.feed(value)

  fun setFontSize(value: Double?) = terminalView.setTerminalFontSize(value)

  fun focus(nonce: Int?) = terminalView.focusForNonce(nonce)

  fun armControl(nonce: Int?) = terminalView.armControlForNonce(nonce)

  fun dispose() = terminalView.dispose()

  private fun emitInput(data: String) {
    onInput(mapOf("data" to data))
  }

  private fun emitResize(columns: Int, rows: Int) {
    onResize(mapOf("cols" to columns, "rows" to rows))
  }

  private fun emitLink(url: String) {
    onOpenLink(mapOf("url" to url))
  }
}
