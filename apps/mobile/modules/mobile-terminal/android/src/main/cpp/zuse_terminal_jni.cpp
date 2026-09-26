#include <jni.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <mutex>
#include <new>
#include <string>
#include <utility>
#include <vector>

#include <ghostty/vt.h>

namespace {

constexpr std::size_t kMaxFrameBytes = 16U * 1024U * 1024U;
constexpr std::size_t kMaxEncodedKeyBytes = 64U * 1024U;
constexpr std::size_t kMaxPasteBytes = 4U * 1024U * 1024U;
constexpr std::size_t kMaxEncodedMouseBytes = 128U;
constexpr std::size_t kMaxSelectionBytes = 4U * 1024U * 1024U;
constexpr std::size_t kMaxPtyResponseBytes = 1U * 1024U * 1024U;

struct Session {
  GhosttyTerminal terminal = nullptr;
  GhosttyRenderState render_state = nullptr;
  GhosttyRenderStateRowIterator row_iterator = nullptr;
  GhosttyRenderStateRowCells row_cells = nullptr;
  GhosttyKeyEncoder key_encoder = nullptr;
  GhosttyKeyEvent key_event = nullptr;
  GhosttyMouseEncoder mouse_encoder = nullptr;
  GhosttyMouseEvent mouse_event = nullptr;
  bool mouse_button_pressed = false;
  bool focus_reporting_active = false;
  bool reported_focus = false;
  std::vector<std::uint8_t> pty_response;
  std::mutex mutex;

  ~Session() {
    ghostty_mouse_event_free(mouse_event);
    ghostty_mouse_encoder_free(mouse_encoder);
    ghostty_key_event_free(key_event);
    ghostty_key_encoder_free(key_encoder);
    ghostty_render_state_row_cells_free(row_cells);
    ghostty_render_state_row_iterator_free(row_iterator);
    ghostty_render_state_free(render_state);
    ghostty_terminal_free(terminal);
  }
};

Session* session_from(jlong handle) {
  return reinterpret_cast<Session*>(static_cast<std::uintptr_t>(handle));
}

jlong handle_for(Session* session) {
  return static_cast<jlong>(reinterpret_cast<std::uintptr_t>(session));
}

void write_pty(
    GhosttyTerminal,
    void* userdata,
    const std::uint8_t* data,
    std::size_t length) {
  auto* session = static_cast<Session*>(userdata);
  if (session == nullptr || data == nullptr || length == 0) return;
  const std::size_t available =
      kMaxPtyResponseBytes - std::min(kMaxPtyResponseBytes, session->pty_response.size());
  const std::size_t accepted = std::min(length, available);
  session->pty_response.insert(session->pty_response.end(), data, data + accepted);
}

jbyteArray byte_array(JNIEnv* env, const std::vector<std::uint8_t>& bytes) {
  const auto length = static_cast<jsize>(std::min<std::size_t>(
      bytes.size(),
      static_cast<std::size_t>(std::numeric_limits<jsize>::max())));
  jbyteArray result = env->NewByteArray(length);
  if (result != nullptr && length > 0) {
    env->SetByteArrayRegion(
        result,
        0,
        length,
        reinterpret_cast<const jbyte*>(bytes.data()));
  }
  return result;
}

std::vector<std::uint8_t> java_bytes(JNIEnv* env, jbyteArray input) {
  if (input == nullptr) return {};
  const jsize length = env->GetArrayLength(input);
  if (length <= 0) return {};
  std::vector<std::uint8_t> result(static_cast<std::size_t>(length));
  env->GetByteArrayRegion(
      input,
      0,
      length,
      reinterpret_cast<jbyte*>(result.data()));
  return result;
}

void append_utf8(std::string& output, std::uint32_t codepoint) {
  if (codepoint <= 0x7fU) {
    output.push_back(static_cast<char>(codepoint));
  } else if (codepoint <= 0x7ffU) {
    output.push_back(static_cast<char>(0xc0U | (codepoint >> 6U)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else if (codepoint <= 0xffffU) {
    output.push_back(static_cast<char>(0xe0U | (codepoint >> 12U)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  } else {
    output.push_back(static_cast<char>(0xf0U | (codepoint >> 18U)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 12U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | ((codepoint >> 6U) & 0x3fU)));
    output.push_back(static_cast<char>(0x80U | (codepoint & 0x3fU)));
  }
}

std::string java_string(JNIEnv* env, jstring input) {
  if (input == nullptr) return {};
  const jsize length = env->GetStringLength(input);
  const jchar* chars = env->GetStringChars(input, nullptr);
  if (chars == nullptr) return {};
  std::string output;
  output.reserve(static_cast<std::size_t>(length));
  for (jsize index = 0; index < length; ++index) {
    std::uint32_t codepoint = chars[index];
    if (
        codepoint >= 0xd800U && codepoint <= 0xdbffU && index + 1 < length &&
        chars[index + 1] >= 0xdc00U && chars[index + 1] <= 0xdfffU) {
      codepoint =
          0x10000U + ((codepoint - 0xd800U) << 10U) + (chars[++index] - 0xdc00U);
    } else if (codepoint >= 0xd800U && codepoint <= 0xdfffU) {
      codepoint = 0xfffdU;
    }
    append_utf8(output, codepoint);
  }
  env->ReleaseStringChars(input, chars);
  return output;
}

std::u16string utf8_to_utf16(const std::uint8_t* bytes, std::size_t length) {
  std::u16string output;
  output.reserve(length);
  for (std::size_t index = 0; index < length;) {
    const std::uint8_t first = bytes[index++];
    std::uint32_t codepoint = 0xfffdU;
    std::size_t continuation_count = 0;
    if (first < 0x80U) {
      codepoint = first;
    } else if ((first & 0xe0U) == 0xc0U) {
      codepoint = first & 0x1fU;
      continuation_count = 1;
    } else if ((first & 0xf0U) == 0xe0U) {
      codepoint = first & 0x0fU;
      continuation_count = 2;
    } else if ((first & 0xf8U) == 0xf0U) {
      codepoint = first & 0x07U;
      continuation_count = 3;
    }
    bool valid = index + continuation_count <= length;
    for (std::size_t offset = 0; valid && offset < continuation_count; ++offset) {
      const std::uint8_t next = bytes[index + offset];
      if ((next & 0xc0U) != 0x80U) {
        valid = false;
      } else {
        codepoint = (codepoint << 6U) | (next & 0x3fU);
      }
    }
    if (valid) index += continuation_count;
    if (!valid || codepoint > 0x10ffffU || (codepoint >= 0xd800U && codepoint <= 0xdfffU)) {
      codepoint = 0xfffdU;
    }
    if (codepoint <= 0xffffU) {
      output.push_back(static_cast<char16_t>(codepoint));
    } else {
      codepoint -= 0x10000U;
      output.push_back(static_cast<char16_t>(0xd800U + (codepoint >> 10U)));
      output.push_back(static_cast<char16_t>(0xdc00U + (codepoint & 0x3ffU)));
    }
  }
  return output;
}

jstring java_utf8(JNIEnv* env, const std::uint8_t* bytes, std::size_t length) {
  const std::u16string text = utf8_to_utf16(bytes, length);
  return env->NewString(
      reinterpret_cast<const jchar*>(text.data()),
      static_cast<jsize>(text.size()));
}

void append_u8(std::vector<std::uint8_t>& output, std::uint8_t value) {
  output.push_back(value);
}

void append_u16(std::vector<std::uint8_t>& output, std::uint16_t value) {
  output.push_back(static_cast<std::uint8_t>(value & 0xffU));
  output.push_back(static_cast<std::uint8_t>((value >> 8U) & 0xffU));
}

void append_u32(std::vector<std::uint8_t>& output, std::uint32_t value) {
  for (unsigned shift = 0; shift < 32U; shift += 8U) {
    output.push_back(static_cast<std::uint8_t>((value >> shift) & 0xffU));
  }
}

void append_color(std::vector<std::uint8_t>& output, GhosttyColorRgb color) {
  append_u8(output, color.r);
  append_u8(output, color.g);
  append_u8(output, color.b);
}

GhosttyKey key_from_codepoint(std::uint32_t codepoint) {
  if (codepoint >= 'a' && codepoint <= 'z') {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_A + (codepoint - 'a'));
  }
  if (codepoint >= 'A' && codepoint <= 'Z') {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_A + (codepoint - 'A'));
  }
  if (codepoint >= '0' && codepoint <= '9') {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_DIGIT_0 + (codepoint - '0'));
  }
  switch (codepoint) {
    case ' ': return GHOSTTY_KEY_SPACE;
    case '`': return GHOSTTY_KEY_BACKQUOTE;
    case '\\': return GHOSTTY_KEY_BACKSLASH;
    case '[': return GHOSTTY_KEY_BRACKET_LEFT;
    case ']': return GHOSTTY_KEY_BRACKET_RIGHT;
    case ',': return GHOSTTY_KEY_COMMA;
    case '=': return GHOSTTY_KEY_EQUAL;
    case '-': return GHOSTTY_KEY_MINUS;
    case '.': return GHOSTTY_KEY_PERIOD;
    case '\'': return GHOSTTY_KEY_QUOTE;
    case ';': return GHOSTTY_KEY_SEMICOLON;
    case '/': return GHOSTTY_KEY_SLASH;
    default: return GHOSTTY_KEY_UNIDENTIFIED;
  }
}

GhosttyKey key_from_android(std::int32_t keycode, std::uint32_t codepoint) {
  if (keycode >= 29 && keycode <= 54) {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_A + (keycode - 29));
  }
  if (keycode >= 7 && keycode <= 16) {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_DIGIT_0 + (keycode - 7));
  }
  if (keycode >= 131 && keycode <= 142) {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_F1 + (keycode - 131));
  }
  if (keycode >= 144 && keycode <= 153) {
    return static_cast<GhosttyKey>(GHOSTTY_KEY_NUMPAD_0 + (keycode - 144));
  }
  switch (keycode) {
    case 19: return GHOSTTY_KEY_ARROW_UP;
    case 20: return GHOSTTY_KEY_ARROW_DOWN;
    case 21: return GHOSTTY_KEY_ARROW_LEFT;
    case 22: return GHOSTTY_KEY_ARROW_RIGHT;
    case 23: return GHOSTTY_KEY_ENTER;
    case 55: return GHOSTTY_KEY_COMMA;
    case 56: return GHOSTTY_KEY_PERIOD;
    case 57: return GHOSTTY_KEY_ALT_LEFT;
    case 58: return GHOSTTY_KEY_ALT_RIGHT;
    case 59: return GHOSTTY_KEY_SHIFT_LEFT;
    case 60: return GHOSTTY_KEY_SHIFT_RIGHT;
    case 61: return GHOSTTY_KEY_TAB;
    case 62: return GHOSTTY_KEY_SPACE;
    case 66: return GHOSTTY_KEY_ENTER;
    case 67: return GHOSTTY_KEY_BACKSPACE;
    case 68: return GHOSTTY_KEY_BACKQUOTE;
    case 69: return GHOSTTY_KEY_MINUS;
    case 70: return GHOSTTY_KEY_EQUAL;
    case 71: return GHOSTTY_KEY_BRACKET_LEFT;
    case 72: return GHOSTTY_KEY_BRACKET_RIGHT;
    case 73: return GHOSTTY_KEY_BACKSLASH;
    case 74: return GHOSTTY_KEY_SEMICOLON;
    case 75: return GHOSTTY_KEY_QUOTE;
    case 76: return GHOSTTY_KEY_SLASH;
    case 82: return GHOSTTY_KEY_CONTEXT_MENU;
    case 92: return GHOSTTY_KEY_PAGE_UP;
    case 93: return GHOSTTY_KEY_PAGE_DOWN;
    case 111: return GHOSTTY_KEY_ESCAPE;
    case 112: return GHOSTTY_KEY_DELETE;
    case 113: return GHOSTTY_KEY_CONTROL_LEFT;
    case 114: return GHOSTTY_KEY_CONTROL_RIGHT;
    case 115: return GHOSTTY_KEY_CAPS_LOCK;
    case 116: return GHOSTTY_KEY_SCROLL_LOCK;
    case 117: return GHOSTTY_KEY_META_LEFT;
    case 118: return GHOSTTY_KEY_META_RIGHT;
    case 120: return GHOSTTY_KEY_PRINT_SCREEN;
    case 121: return GHOSTTY_KEY_PAUSE;
    case 122: return GHOSTTY_KEY_HOME;
    case 123: return GHOSTTY_KEY_END;
    case 124: return GHOSTTY_KEY_INSERT;
    case 143: return GHOSTTY_KEY_NUM_LOCK;
    case 154: return GHOSTTY_KEY_NUMPAD_DIVIDE;
    case 155: return GHOSTTY_KEY_NUMPAD_MULTIPLY;
    case 156: return GHOSTTY_KEY_NUMPAD_SUBTRACT;
    case 157: return GHOSTTY_KEY_NUMPAD_ADD;
    case 158: return GHOSTTY_KEY_NUMPAD_DECIMAL;
    case 159: return GHOSTTY_KEY_NUMPAD_COMMA;
    case 160: return GHOSTTY_KEY_NUMPAD_ENTER;
    case 161: return GHOSTTY_KEY_NUMPAD_EQUAL;
    case 162: return GHOSTTY_KEY_NUMPAD_PAREN_LEFT;
    case 163: return GHOSTTY_KEY_NUMPAD_PAREN_RIGHT;
    default: return key_from_codepoint(codepoint);
  }
}

std::vector<std::uint8_t> take_response(Session& session) {
  std::vector<std::uint8_t> response;
  response.swap(session.pty_response);
  return response;
}

std::vector<std::uint8_t> grapheme_bytes(GhosttyRenderStateRowCells cells) {
  std::uint8_t local[64] = {};
  GhosttyBuffer buffer = {.ptr = local, .cap = sizeof(local), .len = 0};
  GhosttyResult result = ghostty_render_state_row_cells_get(
      cells,
      GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8,
      &buffer);
  if (result == GHOSTTY_SUCCESS) return {local, local + buffer.len};
  if (result != GHOSTTY_OUT_OF_SPACE || buffer.len > 4096U) return {};
  std::vector<std::uint8_t> dynamic(buffer.len);
  buffer.ptr = dynamic.data();
  buffer.cap = dynamic.size();
  if (
      ghostty_render_state_row_cells_get(
          cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_UTF8,
          &buffer) != GHOSTTY_SUCCESS) {
    return {};
  }
  dynamic.resize(buffer.len);
  return dynamic;
}

std::vector<std::uint8_t> render_frame(Session& session) {
  if (ghostty_render_state_update(session.render_state, session.terminal) != GHOSTTY_SUCCESS) {
    return {};
  }

  std::uint16_t columns = 0;
  std::uint16_t rows = 0;
  bool cursor_visible = false;
  bool cursor_blinking = false;
  bool cursor_has_value = false;
  std::uint16_t cursor_column = std::numeric_limits<std::uint16_t>::max();
  std::uint16_t cursor_row = std::numeric_limits<std::uint16_t>::max();
  GhosttyRenderStateCursorVisualStyle cursor_style =
      GHOSTTY_RENDER_STATE_CURSOR_VISUAL_STYLE_BLOCK;
  GhosttyRenderStateColors colors = {};
  colors.size = sizeof(colors);
  if (
      ghostty_render_state_get(
          session.render_state, GHOSTTY_RENDER_STATE_DATA_COLS, &columns) != GHOSTTY_SUCCESS ||
      ghostty_render_state_get(
          session.render_state, GHOSTTY_RENDER_STATE_DATA_ROWS, &rows) != GHOSTTY_SUCCESS ||
      columns == 0 || rows == 0 ||
      ghostty_render_state_colors_get(session.render_state, &colors) != GHOSTTY_SUCCESS) {
    return {};
  }
  ghostty_render_state_get(
      session.render_state, GHOSTTY_RENDER_STATE_DATA_CURSOR_VISIBLE, &cursor_visible);
  ghostty_render_state_get(
      session.render_state, GHOSTTY_RENDER_STATE_DATA_CURSOR_BLINKING, &cursor_blinking);
  ghostty_render_state_get(
      session.render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_HAS_VALUE,
      &cursor_has_value);
  ghostty_render_state_get(
      session.render_state,
      GHOSTTY_RENDER_STATE_DATA_CURSOR_VISUAL_STYLE,
      &cursor_style);
  if (cursor_has_value) {
    ghostty_render_state_get(
        session.render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_X,
        &cursor_column);
    ghostty_render_state_get(
        session.render_state,
        GHOSTTY_RENDER_STATE_DATA_CURSOR_VIEWPORT_Y,
        &cursor_row);
  }

  const std::uint64_t cell_count_64 =
      static_cast<std::uint64_t>(columns) * static_cast<std::uint64_t>(rows);
  if (cell_count_64 > 1'000'000U) return {};
  const auto cell_count = static_cast<std::uint32_t>(cell_count_64);
  std::vector<std::uint8_t> output;
  output.reserve(std::min<std::size_t>(
      kMaxFrameBytes,
      27U + static_cast<std::size_t>(cell_count) * 12U));
  append_u8(output, 'Z');
  append_u8(output, 'V');
  append_u8(output, 'T');
  append_u8(output, '1');
  append_u16(output, columns);
  append_u16(output, rows);
  append_u16(output, cursor_column);
  append_u16(output, cursor_row);
  append_u8(output, static_cast<std::uint8_t>(cursor_style));
  append_u8(
      output,
      static_cast<std::uint8_t>((cursor_visible ? 1U : 0U) | (cursor_blinking ? 2U : 0U)));
  append_color(output, colors.background);
  append_color(output, colors.foreground);
  append_color(output, colors.cursor_has_value ? colors.cursor : colors.foreground);
  append_u32(output, cell_count);

  if (
      ghostty_render_state_get(
          session.render_state,
          GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR,
          &session.row_iterator) != GHOSTTY_SUCCESS) {
    return {};
  }

  std::uint32_t written_cells = 0;
  while (
      written_cells < cell_count &&
      ghostty_render_state_row_iterator_next(session.row_iterator)) {
    if (
        ghostty_render_state_row_get(
            session.row_iterator,
            GHOSTTY_RENDER_STATE_ROW_DATA_CELLS,
            &session.row_cells) != GHOSTTY_SUCCESS) {
      return {};
    }
    while (
        written_cells < cell_count &&
        ghostty_render_state_row_cells_next(session.row_cells)) {
      GhosttyStyle style = {};
      style.size = sizeof(style);
      GhosttyColorRgb foreground = colors.foreground;
      GhosttyColorRgb background = colors.background;
      bool selected = false;
      ghostty_render_state_row_cells_get(
          session.row_cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE,
          &style);
      ghostty_render_state_row_cells_get(
          session.row_cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED,
          &selected);
      ghostty_render_state_row_cells_get(
          session.row_cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR,
          &foreground);
      ghostty_render_state_row_cells_get(
          session.row_cells,
          GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR,
          &background);
      if (style.inverse) std::swap(foreground, background);

      std::uint16_t flags = 0;
      if (selected) flags |= 1U;
      if (style.bold) flags |= 1U << 1U;
      if (style.italic) flags |= 1U << 2U;
      if (style.faint) flags |= 1U << 3U;
      if (style.underline != 0) flags |= 1U << 4U;
      if (style.strikethrough) flags |= 1U << 5U;
      if (style.overline) flags |= 1U << 6U;
      if (style.invisible) flags |= 1U << 7U;
      if (style.blink) flags |= 1U << 8U;
      const std::vector<std::uint8_t> grapheme = grapheme_bytes(session.row_cells);
      if (grapheme.size() > std::numeric_limits<std::uint16_t>::max()) return {};

      append_u16(output, flags);
      append_color(output, foreground);
      append_color(output, background);
      append_u16(output, static_cast<std::uint16_t>(grapheme.size()));
      output.insert(output.end(), grapheme.begin(), grapheme.end());
      if (output.size() > kMaxFrameBytes) return {};
      ++written_cells;
    }
  }
  if (written_cells != cell_count) return {};
  return output;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_create(
    JNIEnv*,
    jclass,
    jint columns,
    jint rows,
    jint cell_width,
    jint cell_height) {
  if (columns <= 0 || rows <= 0 || columns > 1000 || rows > 1000) return 0;
  auto* session = new (std::nothrow) Session();
  if (session == nullptr) return 0;
  const GhosttyTerminalOptions options = {
      .cols = static_cast<std::uint16_t>(columns),
      .rows = static_cast<std::uint16_t>(rows),
      .max_scrollback = 10'000,
  };
  const bool initialized =
      ghostty_terminal_new(nullptr, &session->terminal, options) == GHOSTTY_SUCCESS &&
      ghostty_render_state_new(nullptr, &session->render_state) == GHOSTTY_SUCCESS &&
      ghostty_render_state_row_iterator_new(nullptr, &session->row_iterator) == GHOSTTY_SUCCESS &&
      ghostty_render_state_row_cells_new(nullptr, &session->row_cells) == GHOSTTY_SUCCESS &&
      ghostty_key_encoder_new(nullptr, &session->key_encoder) == GHOSTTY_SUCCESS &&
      ghostty_key_event_new(nullptr, &session->key_event) == GHOSTTY_SUCCESS &&
      ghostty_mouse_encoder_new(nullptr, &session->mouse_encoder) == GHOSTTY_SUCCESS &&
      ghostty_mouse_event_new(nullptr, &session->mouse_event) == GHOSTTY_SUCCESS;
  if (!initialized) {
    delete session;
    return 0;
  }
  ghostty_terminal_set(
      session->terminal,
      GHOSTTY_TERMINAL_OPT_USERDATA,
      session);
  ghostty_terminal_set(
      session->terminal,
      GHOSTTY_TERMINAL_OPT_WRITE_PTY,
      reinterpret_cast<const void*>(write_pty));
  const GhosttyColorRgb foreground = {.r = 232, .g = 234, .b = 239};
  const GhosttyColorRgb background = {.r = 17, .g = 17, .b = 17};
  const GhosttyColorRgb cursor = {.r = 216, .g = 220, .b = 230};
  ghostty_terminal_set(
      session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &foreground);
  ghostty_terminal_set(
      session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &background);
  ghostty_terminal_set(
      session->terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &cursor);
  ghostty_terminal_resize(
      session->terminal,
      static_cast<std::uint16_t>(columns),
      static_cast<std::uint16_t>(rows),
      static_cast<std::uint32_t>(std::max(1, cell_width)),
      static_cast<std::uint32_t>(std::max(1, cell_height)));
  ghostty_mouse_encoder_setopt_from_terminal(
      session->mouse_encoder,
      session->terminal);
  return handle_for(session);
}

extern "C" JNIEXPORT void JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_destroy(
    JNIEnv*,
    jclass,
    jlong handle) {
  delete session_from(handle);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_feed(
    JNIEnv* env,
    jclass,
    jlong handle,
    jbyteArray input) {
  Session* session = session_from(handle);
  if (session == nullptr) return env->NewByteArray(0);
  const std::vector<std::uint8_t> bytes = java_bytes(env, input);
  std::lock_guard lock(session->mutex);
  session->pty_response.clear();
  if (!bytes.empty()) {
    ghostty_terminal_vt_write(session->terminal, bytes.data(), bytes.size());
    ghostty_mouse_encoder_setopt_from_terminal(
        session->mouse_encoder,
        session->terminal);
  }
  return byte_array(env, take_response(*session));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_resize(
    JNIEnv* env,
    jclass,
    jlong handle,
    jint columns,
    jint rows,
    jint cell_width,
    jint cell_height) {
  Session* session = session_from(handle);
  if (
      session == nullptr || columns <= 0 || rows <= 0 || columns > 1000 || rows > 1000) {
    return env->NewByteArray(0);
  }
  std::lock_guard lock(session->mutex);
  session->pty_response.clear();
  ghostty_terminal_resize(
      session->terminal,
      static_cast<std::uint16_t>(columns),
      static_cast<std::uint16_t>(rows),
      static_cast<std::uint32_t>(std::max(1, cell_width)),
      static_cast<std::uint32_t>(std::max(1, cell_height)));
  return byte_array(env, take_response(*session));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_render(
    JNIEnv* env,
    jclass,
    jlong handle) {
  Session* session = session_from(handle);
  if (session == nullptr) return env->NewByteArray(0);
  std::lock_guard lock(session->mutex);
  return byte_array(env, render_frame(*session));
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_encodeKey(
    JNIEnv* env,
    jclass,
    jlong handle,
    jint android_keycode,
    jint codepoint,
    jstring input_text,
    jint modifiers,
    jint action) {
  Session* session = session_from(handle);
  if (session == nullptr) return env->NewByteArray(0);
  const std::string text = java_string(env, input_text);
  std::lock_guard lock(session->mutex);
  ghostty_key_encoder_setopt_from_terminal(session->key_encoder, session->terminal);
  ghostty_key_event_set_action(
      session->key_event,
      action == 0
          ? GHOSTTY_KEY_ACTION_RELEASE
          : (action == 2 ? GHOSTTY_KEY_ACTION_REPEAT : GHOSTTY_KEY_ACTION_PRESS));
  ghostty_key_event_set_key(
      session->key_event,
      key_from_android(android_keycode, static_cast<std::uint32_t>(std::max(0, codepoint))));
  ghostty_key_event_set_mods(
      session->key_event,
      static_cast<GhosttyMods>(modifiers & 0x3ff));
  ghostty_key_event_set_consumed_mods(session->key_event, 0);
  ghostty_key_event_set_composing(session->key_event, false);
  ghostty_key_event_set_utf8(
      session->key_event,
      text.empty() ? nullptr : text.data(),
      text.size());
  ghostty_key_event_set_unshifted_codepoint(
      session->key_event,
      static_cast<std::uint32_t>(std::max(0, codepoint)));

  std::size_t required = 0;
  GhosttyResult result = ghostty_key_encoder_encode(
      session->key_encoder, session->key_event, nullptr, 0, &required);
  if (result == GHOSTTY_SUCCESS && required == 0) return env->NewByteArray(0);
  if (result != GHOSTTY_OUT_OF_SPACE || required > kMaxEncodedKeyBytes) {
    return env->NewByteArray(0);
  }
  std::vector<std::uint8_t> encoded(required);
  result = ghostty_key_encoder_encode(
      session->key_encoder,
      session->key_event,
      reinterpret_cast<char*>(encoded.data()),
      encoded.size(),
      &required);
  if (result != GHOSTTY_SUCCESS) return env->NewByteArray(0);
  encoded.resize(required);
  return byte_array(env, encoded);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_encodePaste(
    JNIEnv* env,
    jclass,
    jlong handle,
    jstring input_text) {
  Session* session = session_from(handle);
  if (session == nullptr) return env->NewByteArray(0);
  const std::string text = java_string(env, input_text);
  if (text.empty() || text.size() > kMaxPasteBytes) return env->NewByteArray(0);
  std::vector<char> input(text.begin(), text.end());
  std::lock_guard lock(session->mutex);
  bool bracketed = false;
  if (
      ghostty_terminal_mode_get(
          session->terminal,
          GHOSTTY_MODE_BRACKETED_PASTE,
          &bracketed) != GHOSTTY_SUCCESS) {
    return env->NewByteArray(0);
  }
  constexpr std::size_t kBracketBytes = 12U;
  std::vector<std::uint8_t> encoded(text.size() + kBracketBytes);
  std::size_t written = 0;
  const GhosttyResult result = ghostty_paste_encode(
      input.data(),
      input.size(),
      bracketed,
      reinterpret_cast<char*>(encoded.data()),
      encoded.size(),
      &written);
  if (result != GHOSTTY_SUCCESS || written > encoded.size()) {
    return env->NewByteArray(0);
  }
  encoded.resize(written);
  return byte_array(env, encoded);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_encodeFocus(
    JNIEnv* env,
    jclass,
    jlong handle,
    jboolean focused) {
  Session* session = session_from(handle);
  if (session == nullptr) return env->NewByteArray(0);
  std::lock_guard lock(session->mutex);
  bool reporting = false;
  if (
      ghostty_terminal_mode_get(
          session->terminal,
          GHOSTTY_MODE_FOCUS_EVENT,
          &reporting) != GHOSTTY_SUCCESS ||
      !reporting) {
    session->focus_reporting_active = false;
    return env->NewByteArray(0);
  }
  const bool next_focus = focused == JNI_TRUE;
  if (session->focus_reporting_active && session->reported_focus == next_focus) {
    return env->NewByteArray(0);
  }
  std::vector<std::uint8_t> encoded(16U);
  std::size_t written = 0;
  const GhosttyResult result = ghostty_focus_encode(
      next_focus ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST,
      reinterpret_cast<char*>(encoded.data()),
      encoded.size(),
      &written);
  if (result != GHOSTTY_SUCCESS || written > encoded.size()) {
    return env->NewByteArray(0);
  }
  session->focus_reporting_active = true;
  session->reported_focus = next_focus;
  encoded.resize(written);
  return byte_array(env, encoded);
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_encodeMouse(
    JNIEnv* env,
    jclass,
    jlong handle,
    jint action,
    jint button,
    jint modifiers,
    jfloat x,
    jfloat y,
    jint screen_width,
    jint screen_height,
    jint cell_width,
    jint cell_height) {
  Session* session = session_from(handle);
  if (
      session == nullptr || action < 0 || action > 2 || button < 0 || button > 11 ||
      screen_width <= 0 || screen_height <= 0 || cell_width <= 0 || cell_height <= 0 ||
      screen_width > 100'000 || screen_height > 100'000 || !std::isfinite(x) ||
      !std::isfinite(y)) {
    return env->NewByteArray(0);
  }

  std::lock_guard lock(session->mutex);
  const GhosttyMouseEncoderSize size = {
      .size = sizeof(GhosttyMouseEncoderSize),
      .screen_width = static_cast<std::uint32_t>(screen_width),
      .screen_height = static_cast<std::uint32_t>(screen_height),
      .cell_width = static_cast<std::uint32_t>(cell_width),
      .cell_height = static_cast<std::uint32_t>(cell_height),
      .padding_top = 0,
      .padding_bottom = 0,
      .padding_right = 0,
      .padding_left = 0,
  };
  ghostty_mouse_encoder_setopt(
      session->mouse_encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
      &size);
  const bool any_button_pressed =
      action == GHOSTTY_MOUSE_ACTION_PRESS ||
      (action == GHOSTTY_MOUSE_ACTION_MOTION && session->mouse_button_pressed);
  ghostty_mouse_encoder_setopt(
      session->mouse_encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED,
      &any_button_pressed);
  constexpr bool kTrackLastCell = true;
  ghostty_mouse_encoder_setopt(
      session->mouse_encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL,
      &kTrackLastCell);

  ghostty_mouse_event_set_action(
      session->mouse_event,
      static_cast<GhosttyMouseAction>(action));
  if (button == GHOSTTY_MOUSE_BUTTON_UNKNOWN) {
    ghostty_mouse_event_clear_button(session->mouse_event);
  } else {
    ghostty_mouse_event_set_button(
        session->mouse_event,
        static_cast<GhosttyMouseButton>(button));
  }
  ghostty_mouse_event_set_mods(
      session->mouse_event,
      static_cast<GhosttyMods>(modifiers & 0x3ff));
  ghostty_mouse_event_set_position(session->mouse_event, {.x = x, .y = y});

  std::size_t required = 0;
  GhosttyResult result = ghostty_mouse_encoder_encode(
      session->mouse_encoder,
      session->mouse_event,
      nullptr,
      0,
      &required);
  if (result == GHOSTTY_SUCCESS && required == 0) {
    if (action == GHOSTTY_MOUSE_ACTION_RELEASE) session->mouse_button_pressed = false;
    return env->NewByteArray(0);
  }
  if (result != GHOSTTY_OUT_OF_SPACE || required > kMaxEncodedMouseBytes) {
    if (action == GHOSTTY_MOUSE_ACTION_RELEASE) session->mouse_button_pressed = false;
    return env->NewByteArray(0);
  }
  std::vector<std::uint8_t> encoded(required);
  result = ghostty_mouse_encoder_encode(
      session->mouse_encoder,
      session->mouse_event,
      reinterpret_cast<char*>(encoded.data()),
      encoded.size(),
      &required);
  if (result != GHOSTTY_SUCCESS || required > encoded.size()) {
    if (action == GHOSTTY_MOUSE_ACTION_RELEASE) session->mouse_button_pressed = false;
    return env->NewByteArray(0);
  }
  if (
      action == GHOSTTY_MOUSE_ACTION_PRESS &&
      button >= GHOSTTY_MOUSE_BUTTON_LEFT &&
      button <= GHOSTTY_MOUSE_BUTTON_MIDDLE) {
    session->mouse_button_pressed = true;
  } else if (action == GHOSTTY_MOUSE_ACTION_RELEASE) {
    session->mouse_button_pressed = false;
  }
  encoded.resize(required);
  return byte_array(env, encoded);
}

extern "C" JNIEXPORT void JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_scroll(
    JNIEnv*,
    jclass,
    jlong handle,
    jint rows) {
  Session* session = session_from(handle);
  if (session == nullptr || rows == 0) return;
  std::lock_guard lock(session->mutex);
  GhosttyTerminalScrollViewport scroll = {};
  scroll.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA;
  scroll.value.delta = rows;
  ghostty_terminal_scroll_viewport(session->terminal, scroll);
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_select(
    JNIEnv*,
    jclass,
    jlong handle,
    jint start_column,
    jint start_row,
    jint end_column,
    jint end_row) {
  Session* session = session_from(handle);
  if (
      session == nullptr || start_column < 0 || start_row < 0 || end_column < 0 ||
      end_row < 0) {
    return JNI_FALSE;
  }
  std::lock_guard lock(session->mutex);
  GhosttyPoint start_point = {};
  start_point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
  start_point.value.coordinate = {
      .x = static_cast<std::uint16_t>(start_column),
      .y = static_cast<std::uint32_t>(start_row),
  };
  GhosttyPoint end_point = {};
  end_point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
  end_point.value.coordinate = {
      .x = static_cast<std::uint16_t>(end_column),
      .y = static_cast<std::uint32_t>(end_row),
  };
  GhosttySelection selection = {};
  selection.size = sizeof(selection);
  if (
      ghostty_terminal_grid_ref(session->terminal, start_point, &selection.start) != GHOSTTY_SUCCESS ||
      ghostty_terminal_grid_ref(session->terminal, end_point, &selection.end) != GHOSTTY_SUCCESS) {
    return JNI_FALSE;
  }
  selection.rectangle = false;
  return ghostty_terminal_set(
             session->terminal,
             GHOSTTY_TERMINAL_OPT_SELECTION,
             &selection) == GHOSTTY_SUCCESS
      ? JNI_TRUE
      : JNI_FALSE;
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_selectedText(
    JNIEnv* env,
    jclass,
    jlong handle) {
  Session* session = session_from(handle);
  if (session == nullptr) return nullptr;
  std::lock_guard lock(session->mutex);
  GhosttyTerminalSelectionFormatOptions options = {};
  options.size = sizeof(options);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.unwrap = true;
  options.trim = true;
  options.selection = nullptr;
  std::size_t required = 0;
  GhosttyResult result = ghostty_terminal_selection_format_buf(
      session->terminal, options, nullptr, 0, &required);
  if (result == GHOSTTY_NO_VALUE) return nullptr;
  if (result != GHOSTTY_OUT_OF_SPACE || required > kMaxSelectionBytes) return nullptr;
  std::vector<std::uint8_t> bytes(required);
  result = ghostty_terminal_selection_format_buf(
      session->terminal, options, bytes.data(), bytes.size(), &required);
  if (result != GHOSTTY_SUCCESS) return nullptr;
  return java_utf8(env, bytes.data(), required);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_linkAt(
    JNIEnv* env,
    jclass,
    jlong handle,
    jint column,
    jint row) {
  Session* session = session_from(handle);
  if (session == nullptr || column < 0 || row < 0) return nullptr;
  std::lock_guard lock(session->mutex);
  GhosttyPoint point = {};
  point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
  point.value.coordinate = {
      .x = static_cast<std::uint16_t>(column),
      .y = static_cast<std::uint32_t>(row),
  };
  GhosttyGridRef reference = {};
  reference.size = sizeof(reference);
  if (ghostty_terminal_grid_ref(session->terminal, point, &reference) != GHOSTTY_SUCCESS) {
    return nullptr;
  }
  std::size_t required = 0;
  GhosttyResult result =
      ghostty_grid_ref_hyperlink_uri(&reference, nullptr, 0, &required);
  if (result == GHOSTTY_SUCCESS && required == 0) return nullptr;
  if (result != GHOSTTY_OUT_OF_SPACE || required > 64U * 1024U) return nullptr;
  std::vector<std::uint8_t> bytes(required);
  result = ghostty_grid_ref_hyperlink_uri(
      &reference, bytes.data(), bytes.size(), &required);
  if (result != GHOSTTY_SUCCESS) return nullptr;
  return java_utf8(env, bytes.data(), required);
}

extern "C" JNIEXPORT jstring JNICALL
Java_com_zuse_mobileterminal_GhosttyTerminalNative_revision(
    JNIEnv* env,
    jclass) {
  return env->NewStringUTF(ZUSE_GHOSTTY_REVISION);
}
