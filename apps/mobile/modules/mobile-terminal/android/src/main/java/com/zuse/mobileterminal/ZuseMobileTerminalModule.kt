package com.zuse.mobileterminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ZuseMobileTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ZuseMobileTerminal")

    View(ZuseMobileTerminalView::class) {
      Events("onInput", "onResize", "onOpenLink")

      Prop("feed") { view: ZuseMobileTerminalView, value: String? ->
        view.feed(value)
      }
      Prop("fontSize") { view: ZuseMobileTerminalView, value: Double? ->
        view.setFontSize(value)
      }
      Prop("focusNonce") { view: ZuseMobileTerminalView, value: Int? ->
        view.focus(value)
      }
      Prop("controlNonce") { view: ZuseMobileTerminalView, value: Int? ->
        view.armControl(value)
      }

      OnViewDestroys { view: ZuseMobileTerminalView ->
        view.dispose()
      }
    }
  }
}
