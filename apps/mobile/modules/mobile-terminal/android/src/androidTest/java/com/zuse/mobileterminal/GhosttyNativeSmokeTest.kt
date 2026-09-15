package com.zuse.mobileterminal

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.view.inputmethod.EditorInfo
import android.widget.LinearLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyMap
import expo.modules.kotlin.KotlinInteropModuleRegistry
import expo.modules.kotlin.ModulesProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.views.ViewManagerWrapperDelegate
import java.lang.ref.WeakReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class GhosttyNativeSmokeTest {
  @Test
  fun nativeViewEncodesBracketedPasteThroughGhosttyMode() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val emitted = mutableListOf<String>()
    lateinit var view: GhosttyTerminalView
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, GhosttyTestActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )

    instrumentation.runOnMainSync {
      view = GhosttyTerminalView(
        instrumentation.targetContext,
        emitted::add,
        { _, _ -> },
        {}
      )
      activity.setContentView(view)
      assertTrue(view.requestFocus())
      view.feed("1\u0000\u001b[?2004h")
    }
    instrumentation.waitForIdleSync()

    instrumentation.runOnMainSync {
      instrumentation.targetContext
        .getSystemService(ClipboardManager::class.java)
        .setPrimaryClip(ClipData.newPlainText("Terminal paste", "hello\nworld\u001b"))

      val connection = view.onCreateInputConnection(EditorInfo())
      assertTrue(connection.performContextMenuAction(android.R.id.paste))
    }

    try {
      assertEquals(listOf("\u001b[200~hello\nworld \u001b[201~"), emitted)
    } finally {
      instrumentation.runOnMainSync {
        view.dispose()
        activity.finish()
      }
    }
  }

  @Test
  fun nativeViewReportsFocusChangesThroughGhosttyMode() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val emitted = mutableListOf<String>()
    lateinit var view: GhosttyTerminalView
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, GhosttyTestActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )

    instrumentation.runOnMainSync {
      val root = LinearLayout(activity)
      val sibling = android.view.View(activity).apply {
        isFocusable = true
        isFocusableInTouchMode = true
      }
      view = GhosttyTerminalView(
        activity,
        emitted::add,
        { _, _ -> },
        {}
      )
      root.addView(view)
      root.addView(sibling)
      activity.setContentView(root)
      assertTrue(view.requestFocus())
      assertTrue(view.hasFocus())

      view.feed("1\u0000\u001b[?1004h")
      assertTrue(sibling.requestFocus())
      assertTrue(view.requestFocus())
      view.requestFocus()
    }

    try {
      assertEquals(listOf("\u001b[I", "\u001b[O", "\u001b[I"), emitted)
    } finally {
      instrumentation.runOnMainSync {
        view.dispose()
        activity.finish()
      }
    }
  }

  @Test
  fun nativeViewReportsTouchMouseEventsThroughGhosttyModes() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val emitted = mutableListOf<String>()
    lateinit var view: GhosttyTerminalView
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, GhosttyTestActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )

    instrumentation.runOnMainSync {
      view = GhosttyTerminalView(
        activity,
        emitted::add,
        { _, _ -> },
        {}
      )
      activity.setContentView(view)
      view.layout(0, 0, 800, 400)
      assertTrue(view.requestFocus())
      view.feed("1\u0000\u001b[?1003h\u001b[?1006h")

      val downTime = SystemClock.uptimeMillis()
      val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, 0f, 0f, 0)
      val up = MotionEvent.obtain(downTime, downTime + 20, MotionEvent.ACTION_UP, 0f, 0f, 0)
      try {
        assertTrue(view.onTouchEvent(down))
        assertTrue(view.onTouchEvent(up))
      } finally {
        down.recycle()
        up.recycle()
      }
    }

    try {
      assertEquals(listOf("\u001b[<0;1;1M", "\u001b[<0;1;1m"), emitted)
    } finally {
      instrumentation.runOnMainSync {
        view.dispose()
        activity.finish()
      }
    }
  }

  @Test
  fun mouseCodecHonorsGhosttyTrackingModesButtonsAndWheel() {
    val handle = GhosttyTerminalNative.create(100, 25, 8, 16)
    assertNotEquals(0L, handle)

    try {
      GhosttyTerminalNative.feed(handle, "\u001b[?1002h\u001b[?1006h".encodeToByteArray())
      assertEquals("", encodeMouse(handle, 2, 0, 0f, 0f))
      assertEquals("\u001b[<0;1;1M", encodeMouse(handle, 0, 1, 0f, 0f))
      assertEquals("\u001b[<32;3;1M", encodeMouse(handle, 2, 1, 16f, 0f))
      assertEquals("\u001b[<0;3;1m", encodeMouse(handle, 1, 1, 16f, 0f))
      assertEquals("", encodeMouse(handle, 2, 0, 24f, 0f))

      GhosttyTerminalNative.feed(
        handle,
        "\u001b[?1002l\u001b[?1003h".encodeToByteArray()
      )
      assertEquals("\u001b[<35;4;1M", encodeMouse(handle, 2, 0, 24f, 0f))
      assertEquals("\u001b[<2;1;1M", encodeMouse(handle, 0, 2, 0f, 0f))
      assertEquals("\u001b[<2;1;1m", encodeMouse(handle, 1, 2, 0f, 0f))
      assertEquals("\u001b[<1;1;1M", encodeMouse(handle, 0, 3, 0f, 0f))
      assertEquals("\u001b[<1;1;1m", encodeMouse(handle, 1, 3, 0f, 0f))
      assertEquals("\u001b[<64;1;1M", encodeMouse(handle, 0, 4, 0f, 0f))
      assertEquals("\u001b[<65;1;1M", encodeMouse(handle, 0, 5, 0f, 0f))
    } finally {
      GhosttyTerminalNative.destroy(handle)
    }
  }

  @Test
  fun nativeViewMapsHardwarePointerButtonsHoverAndWheel() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val emitted = mutableListOf<String>()
    lateinit var view: GhosttyTerminalView
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, GhosttyTestActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )

    instrumentation.runOnMainSync {
      view = GhosttyTerminalView(activity, emitted::add, { _, _ -> }, {})
      activity.setContentView(view)
      view.layout(0, 0, 800, 400)
      assertTrue(view.requestFocus())
      view.feed("1\u0000\u001b[?1002h\u001b[?1006h")

      pointerEvent(MotionEvent.ACTION_HOVER_MOVE).useRecycled {
        assertFalse(view.onGenericMotionEvent(it))
      }
      pointerEvent(
        MotionEvent.ACTION_BUTTON_PRESS,
        buttonState = MotionEvent.BUTTON_SECONDARY
      ).useRecycled { assertTrue(view.onGenericMotionEvent(it)) }
      pointerEvent(MotionEvent.ACTION_BUTTON_RELEASE).useRecycled {
        assertTrue(view.onGenericMotionEvent(it))
      }
      pointerEvent(
        MotionEvent.ACTION_BUTTON_PRESS,
        buttonState = MotionEvent.BUTTON_TERTIARY
      ).useRecycled { assertTrue(view.onGenericMotionEvent(it)) }
      pointerEvent(MotionEvent.ACTION_BUTTON_RELEASE).useRecycled {
        assertTrue(view.onGenericMotionEvent(it))
      }

      view.feed("2\u0000\u001b[?1002l\u001b[?1003h")
      pointerEvent(MotionEvent.ACTION_HOVER_MOVE).useRecycled {
        assertTrue(view.onGenericMotionEvent(it))
      }
      pointerEvent(MotionEvent.ACTION_SCROLL, verticalScroll = 1f).useRecycled {
        assertTrue(view.onGenericMotionEvent(it))
      }
      pointerEvent(MotionEvent.ACTION_SCROLL, verticalScroll = -1f).useRecycled {
        assertTrue(view.onGenericMotionEvent(it))
      }
    }

    try {
      assertEquals(
        listOf(
          "\u001b[<2;1;1M",
          "\u001b[<2;1;1m",
          "\u001b[<1;1;1M",
          "\u001b[<1;1;1m",
          "\u001b[<35;1;1M",
          "\u001b[<64;1;1M",
          "\u001b[<65;1;1M"
        ),
        emitted
      )
    } finally {
      instrumentation.runOnMainSync {
        view.dispose()
        activity.finish()
      }
    }
  }

  @Test
  fun expoModuleViewForwardsPropsAndExportsTerminalEvents() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, GhosttyTestActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    var view: ZuseMobileTerminalView? = null
    var interopRegistry: KotlinInteropModuleRegistry? = null

    try {
      instrumentation.runOnMainSync {
      val reactContext = BridgeReactContext(activity.applicationContext)
      val legacyRegistry = expo.modules.core.ModuleRegistry(emptyList(), emptyList())
      val provider = object : ModulesProvider {
        override fun getModulesMap(): Map<Class<out Module>, String?> =
          mapOf(ZuseMobileTerminalModule::class.java to null)
      }
      val registry = KotlinInteropModuleRegistry(
        provider,
        legacyRegistry,
        WeakReference(reactContext)
      )
      interopRegistry = registry
      val appContext = registry.appContext
      val holder = requireNotNull(appContext.registry.getModuleHolder("ZuseMobileTerminal"))
      val definition = requireNotNull(
        appContext.registry.getViewDefinition(holder, ZuseMobileTerminalView::class.java)
      )
      val delegate = ViewManagerWrapperDelegate(holder, definition)

      assertTrue(
        delegate.props.keys.containsAll(
          setOf("controlNonce", "feed", "focusNonce", "fontSize")
        )
      )
      assertEquals(
        mapOf(
          "topInput" to mapOf("registrationName" to "onInput"),
          "topOpenLink" to mapOf("registrationName" to "onOpenLink"),
          "topResize" to mapOf("registrationName" to "onResize")
        ),
        delegate.getExportedCustomDirectEventTypeConstants()
      )

      val moduleView = delegate.createView(activity) as ZuseMobileTerminalView
      view = moduleView
      val props = JavaOnlyMap.of("feed", "1\u0000expo-wrapper-proof")
      assertEquals(listOf("feed"), delegate.updateProperties(moduleView, props))
      val terminalView = moduleView.getChildAt(0)
      assertTrue(terminalView is GhosttyTerminalView)
      terminalView.draw(Canvas(Bitmap.createBitmap(640, 384, Bitmap.Config.ARGB_8888)))
      assertTrue(terminalView.contentDescription.contains("expo-wrapper-proof"))
      }
    } finally {
      instrumentation.runOnMainSync {
        view?.dispose()
        activity.finish()
        interopRegistry?.onDestroy()
      }
    }
  }

  @Test
  fun nativeViewKeepsScrollLocalWhenMouseModeIsOffAndShiftSelectionLocalWhenOn() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val emitted = mutableListOf<String>()
    lateinit var view: GhosttyTerminalView
    lateinit var beforeScroll: CharSequence
    lateinit var afterScroll: CharSequence
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, GhosttyTestActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    val clipboard = instrumentation.targetContext.getSystemService(ClipboardManager::class.java)

    instrumentation.runOnMainSync {
      clipboard.clearPrimaryClip()
      view = GhosttyTerminalView(
        activity,
        emitted::add,
        { _, _ -> },
        {}
      )
      activity.setContentView(view)
      view.layout(0, 0, 800, 400)
      assertTrue(view.requestFocus())
      val lines = (1..60).joinToString("\r\n") { "line%02d".format(it) }
      view.feed("1\u0000$lines")
      val bitmap = Bitmap.createBitmap(800, 400, Bitmap.Config.ARGB_8888)
      view.draw(Canvas(bitmap))
      beforeScroll = view.contentDescription

      val downTime = SystemClock.uptimeMillis()
      val down = MotionEvent.obtain(downTime, downTime, MotionEvent.ACTION_DOWN, 400f, 160f, 0)
      val move = MotionEvent.obtain(downTime, downTime + 20, MotionEvent.ACTION_MOVE, 400f, 360f, 0)
      val up = MotionEvent.obtain(downTime, downTime + 40, MotionEvent.ACTION_UP, 400f, 360f, 0)
      try {
        view.onTouchEvent(down)
        view.onTouchEvent(move)
        view.onTouchEvent(up)
      } finally {
        down.recycle()
        move.recycle()
        up.recycle()
      }
      view.draw(Canvas(bitmap))
      afterScroll = view.contentDescription

      view.feed("2\u0000\u001b[?1003h\u001b[?1006h")

      val selectionDownTime = SystemClock.uptimeMillis()
      val selectionDown = MotionEvent.obtain(
        selectionDownTime,
        selectionDownTime,
        MotionEvent.ACTION_DOWN,
        1f,
        1f,
        KeyEvent.META_SHIFT_ON
      )
      try {
        view.onTouchEvent(selectionDown)
      } finally {
        selectionDown.recycle()
      }
    }

    SystemClock.sleep(ViewConfiguration.getLongPressTimeout().toLong() + 100)
    instrumentation.waitForIdleSync()
    instrumentation.runOnMainSync {
      val eventTime = SystemClock.uptimeMillis()
      val selectionUp = MotionEvent.obtain(
        eventTime - 20,
        eventTime,
        MotionEvent.ACTION_UP,
        1f,
        1f,
        KeyEvent.META_SHIFT_ON
      )
      try {
        view.onTouchEvent(selectionUp)
      } finally {
        selectionUp.recycle()
      }
    }

    try {
      assertNotEquals(beforeScroll, afterScroll)
      assertTrue(clipboard.primaryClip?.getItemAt(0)?.text?.isNotEmpty() == true)
      assertTrue(emitted.isEmpty())
    } finally {
      instrumentation.runOnMainSync {
        view.dispose()
        activity.finish()
      }
    }
  }

  private fun encodeMouse(
    handle: Long,
    action: Int,
    button: Int,
    x: Float,
    y: Float
  ): String =
    GhosttyTerminalNative.encodeMouse(
      handle,
      action,
      button,
      0,
      x,
      y,
      800,
      400,
      8,
      16
    ).decodeToString()

  private fun pointerEvent(
    action: Int,
    buttonState: Int = 0,
    verticalScroll: Float = 0f
  ): MotionEvent {
    val properties = MotionEvent.PointerProperties().apply {
      id = 0
      toolType = MotionEvent.TOOL_TYPE_MOUSE
    }
    val coordinates = MotionEvent.PointerCoords().apply {
      x = 0f
      y = 0f
      pressure = 1f
      size = 1f
      setAxisValue(MotionEvent.AXIS_VSCROLL, verticalScroll)
    }
    val now = SystemClock.uptimeMillis()
    return MotionEvent.obtain(
      now,
      now,
      action,
      1,
      arrayOf(properties),
      arrayOf(coordinates),
      0,
      buttonState,
      1f,
      1f,
      0,
      0,
      InputDevice.SOURCE_MOUSE,
      0
    )
  }

  private inline fun MotionEvent.useRecycled(block: (MotionEvent) -> Unit) {
    try {
      block(this)
    } finally {
      recycle()
    }
  }

  @Test
  fun exercisesThePinnedTerminalAcrossTheJniBoundary() {
    assertEquals("9f62873bf195e4d8a762d768a1405a5f2f7b1697", GhosttyTerminalNative.revision())
    val handle = GhosttyTerminalNative.create(12, 3, 8, 16)
    assertNotEquals(0L, handle)

    try {
      val terminalReply = GhosttyTerminalNative.feed(
        handle,
        "\u001b]8;;https://example.com\u001b\\hello\u001b]8;;\u001b\\".encodeToByteArray()
      )
      assertTrue(terminalReply.isEmpty())

      val frame = GhosttyFrameDecoder.decode(GhosttyTerminalNative.render(handle))
      assertNotNull(frame)
      assertTrue(requireNotNull(frame).accessibleText().contains("hello"))
      assertEquals("https://example.com", GhosttyTerminalNative.linkAt(handle, 0, 0))

      assertTrue(GhosttyTerminalNative.select(handle, 0, 0, 4, 0))
      assertEquals("hello", GhosttyTerminalNative.selectedText(handle))

      val enter = GhosttyTerminalNative.encodeKey(
        handle,
        KeyEvent.KEYCODE_ENTER,
        '\n'.code,
        null,
        0,
        1
      )
      assertFalse(enter.isEmpty())

      GhosttyTerminalNative.resize(handle, 6, 2, 8, 16)
      val resized = GhosttyFrameDecoder.decode(GhosttyTerminalNative.render(handle))
      assertEquals(6, resized?.columns)
      assertEquals(2, resized?.rows)
    } finally {
      GhosttyTerminalNative.destroy(handle)
    }
  }
}

class GhosttyTestActivity : Activity()
