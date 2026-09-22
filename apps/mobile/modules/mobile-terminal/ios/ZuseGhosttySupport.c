#include "ZuseGhosttySupport.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

struct ZuseGhosttyOutputQueue {
  uint8_t *bytes;
  size_t length;
  size_t capacity;
  bool allocation_failed;
  GhosttySizeReportSize size;
};

struct ZuseGhosttyFocusController {
  bool has_reported_focus;
  bool reported_focus;
  bool previous_was_escape;
};

struct ZuseGhosttyMouseController {
  GhosttyMouseEncoder encoder;
  GhosttyMouseEvent event;
  bool button_pressed;
};

struct ZuseGhosttySelectionController {
  GhosttySelectionGesture gesture;
  GhosttySelectionGestureEvent press;
  GhosttySelectionGestureEvent drag;
  GhosttySelectionGestureEvent autoscroll_tick;
  GhosttySelectionGestureEvent release;
};

static void zuse_ghostty_write_pty(
    GhosttyTerminal terminal,
    void *userdata,
    const uint8_t *data,
    size_t length) {
  (void)terminal;
  ZuseGhosttyOutputQueue *queue = userdata;
  if (queue == NULL || data == NULL || length == 0 || queue->allocation_failed) {
    return;
  }
  if (length > SIZE_MAX - queue->length) {
    queue->allocation_failed = true;
    return;
  }
  const size_t required = queue->length + length;
  if (required > queue->capacity) {
    size_t capacity = queue->capacity == 0 ? 256 : queue->capacity;
    while (capacity < required) {
      if (capacity > SIZE_MAX / 2) {
        capacity = required;
        break;
      }
      capacity *= 2;
    }
    uint8_t *bytes = realloc(queue->bytes, capacity);
    if (bytes == NULL) {
      queue->allocation_failed = true;
      return;
    }
    queue->bytes = bytes;
    queue->capacity = capacity;
  }
  memcpy(queue->bytes + queue->length, data, length);
  queue->length = required;
}

static bool zuse_ghostty_report_size(
    GhosttyTerminal terminal,
    void *userdata,
    GhosttySizeReportSize *out_size) {
  (void)terminal;
  ZuseGhosttyOutputQueue *queue = userdata;
  if (queue == NULL || out_size == NULL) return false;
  *out_size = queue->size;
  return true;
}

static bool zuse_ghostty_report_color_scheme(
    GhosttyTerminal terminal,
    void *userdata,
    GhosttyColorScheme *out_scheme) {
  (void)terminal;
  (void)userdata;
  if (out_scheme == NULL) return false;
  *out_scheme = GHOSTTY_COLOR_SCHEME_DARK;
  return true;
}

ZuseGhosttyOutputQueue *zuse_ghostty_output_queue_new(void) {
  ZuseGhosttyOutputQueue *queue = calloc(1, sizeof(ZuseGhosttyOutputQueue));
  if (queue == NULL) return NULL;
  queue->size.columns = 80;
  queue->size.rows = 24;
  queue->size.cell_width = 1;
  queue->size.cell_height = 1;
  return queue;
}

void zuse_ghostty_output_queue_free(ZuseGhosttyOutputQueue *queue) {
  if (queue == NULL) return;
  free(queue->bytes);
  free(queue);
}

GhosttyResult zuse_ghostty_output_queue_install(
    ZuseGhosttyOutputQueue *queue,
    GhosttyTerminal terminal) {
  if (queue == NULL || terminal == NULL) return GHOSTTY_INVALID_VALUE;
  GhosttyResult result = ghostty_terminal_set(
      terminal,
      GHOSTTY_TERMINAL_OPT_USERDATA,
      queue);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttyTerminalWritePtyFn callback = zuse_ghostty_write_pty;
  result = ghostty_terminal_set(
      terminal,
      GHOSTTY_TERMINAL_OPT_WRITE_PTY,
      (const void *)callback);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttyTerminalSizeFn size_callback = zuse_ghostty_report_size;
  result = ghostty_terminal_set(
      terminal,
      GHOSTTY_TERMINAL_OPT_SIZE,
      (const void *)size_callback);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttyTerminalColorSchemeFn color_scheme_callback =
      zuse_ghostty_report_color_scheme;
  return ghostty_terminal_set(
      terminal,
      GHOSTTY_TERMINAL_OPT_COLOR_SCHEME,
      (const void *)color_scheme_callback);
}

void zuse_ghostty_output_queue_set_size(
    ZuseGhosttyOutputQueue *queue,
    uint16_t columns,
    uint16_t rows,
    uint32_t cell_width,
    uint32_t cell_height) {
  if (queue == NULL || columns == 0 || rows == 0) return;
  queue->size.columns = columns;
  queue->size.rows = rows;
  queue->size.cell_width = cell_width;
  queue->size.cell_height = cell_height;
}

size_t zuse_ghostty_output_queue_length(const ZuseGhosttyOutputQueue *queue) {
  return queue == NULL ? 0 : queue->length;
}

GhosttyResult zuse_ghostty_output_queue_take(
    ZuseGhosttyOutputQueue *queue,
    uint8_t *buffer,
    size_t capacity,
    size_t *out_written) {
  if (queue == NULL || out_written == NULL) return GHOSTTY_INVALID_VALUE;
  *out_written = queue->length;
  if (capacity < queue->length || (queue->length > 0 && buffer == NULL)) {
    return GHOSTTY_OUT_OF_SPACE;
  }
  if (queue->length > 0) memcpy(buffer, queue->bytes, queue->length);
  queue->length = 0;
  const bool failed = queue->allocation_failed;
  queue->allocation_failed = false;
  return failed ? GHOSTTY_OUT_OF_MEMORY : GHOSTTY_SUCCESS;
}

GhosttyResult zuse_ghostty_encode_paste(
    GhosttyTerminal terminal,
    char *input,
    size_t input_length,
    char *output,
    size_t output_capacity,
    size_t *out_written) {
  if (terminal == NULL) return GHOSTTY_INVALID_VALUE;
  bool bracketed = false;
  GhosttyResult result = ghostty_terminal_mode_get(
      terminal,
      GHOSTTY_MODE_BRACKETED_PASTE,
      &bracketed);
  if (result != GHOSTTY_SUCCESS) return result;
  return ghostty_paste_encode(
      input,
      input_length,
      bracketed,
      output,
      output_capacity,
      out_written);
}

GhosttyResult zuse_ghostty_encode_focus(
    GhosttyTerminal terminal,
    bool focused,
    char *output,
    size_t output_capacity,
    size_t *out_written) {
  if (terminal == NULL || out_written == NULL) return GHOSTTY_INVALID_VALUE;
  bool reporting = false;
  GhosttyResult result = ghostty_terminal_mode_get(
      terminal,
      GHOSTTY_MODE_FOCUS_EVENT,
      &reporting);
  if (result != GHOSTTY_SUCCESS) return result;
  if (!reporting) {
    *out_written = 0;
    return GHOSTTY_SUCCESS;
  }
  return ghostty_focus_encode(
      focused ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST,
      output,
      output_capacity,
      out_written);
}

bool zuse_ghostty_focus_reporting_enabled(GhosttyTerminal terminal) {
  bool enabled = false;
  return ghostty_terminal_mode_get(
             terminal,
             GHOSTTY_MODE_FOCUS_EVENT,
             &enabled) == GHOSTTY_SUCCESS &&
      enabled;
}

ZuseGhosttyFocusController *zuse_ghostty_focus_controller_new(void) {
  return calloc(1, sizeof(ZuseGhosttyFocusController));
}

void zuse_ghostty_focus_controller_free(
    ZuseGhosttyFocusController *controller) {
  free(controller);
}

void zuse_ghostty_focus_controller_reset(
    ZuseGhosttyFocusController *controller) {
  if (controller == NULL) return;
  controller->has_reported_focus = false;
  controller->reported_focus = false;
  controller->previous_was_escape = false;
}

bool zuse_ghostty_focus_controller_observe_vt_input(
    ZuseGhosttyFocusController *controller,
    const uint8_t *input,
    size_t input_length) {
  if (controller == NULL || input == NULL) return false;
  bool observed_reset = false;
  for (size_t index = 0; index < input_length; index++) {
    const uint8_t byte = input[index];
    if (controller->previous_was_escape && byte == 'c') {
      // RIS creates a new terminal-mode epoch. A focus report delivered to the
      // previous process cannot satisfy the replacement process, even when its
      // replay re-enables focus reporting in this same input batch.
      controller->has_reported_focus = false;
      controller->reported_focus = false;
      observed_reset = true;
    }
    controller->previous_was_escape = byte == 0x1b;
  }
  return observed_reset;
}

GhosttyResult zuse_ghostty_focus_controller_encode(
    ZuseGhosttyFocusController *controller,
    GhosttyTerminal terminal,
    bool focused,
    char *output,
    size_t output_capacity,
    size_t *out_written) {
  if (controller == NULL || terminal == NULL || out_written == NULL) {
    return GHOSTTY_INVALID_VALUE;
  }
  *out_written = 0;
  bool reporting = false;
  GhosttyResult result = ghostty_terminal_mode_get(
      terminal,
      GHOSTTY_MODE_FOCUS_EVENT,
      &reporting);
  if (result != GHOSTTY_SUCCESS) return result;
  if (!reporting) {
    controller->has_reported_focus = false;
    controller->reported_focus = false;
    return GHOSTTY_SUCCESS;
  }
  if (controller->has_reported_focus &&
      controller->reported_focus == focused) {
    return GHOSTTY_SUCCESS;
  }
  result = ghostty_focus_encode(
      focused ? GHOSTTY_FOCUS_GAINED : GHOSTTY_FOCUS_LOST,
      output,
      output_capacity,
      out_written);
  if (result == GHOSTTY_SUCCESS && *out_written > 0) {
    controller->has_reported_focus = true;
    controller->reported_focus = focused;
  }
  return result;
}

void zuse_ghostty_key_event_set_key_code(
    GhosttyKeyEvent event,
    int32_t key_code) {
  ghostty_key_event_set_key(event, (GhosttyKey)key_code);
}

ZuseGhosttyMouseController *zuse_ghostty_mouse_controller_new(void) {
  ZuseGhosttyMouseController *controller = calloc(1, sizeof(*controller));
  if (controller == NULL) return NULL;
  if (ghostty_mouse_encoder_new(NULL, &controller->encoder) != GHOSTTY_SUCCESS ||
      ghostty_mouse_event_new(NULL, &controller->event) != GHOSTTY_SUCCESS) {
    ghostty_mouse_event_free(controller->event);
    ghostty_mouse_encoder_free(controller->encoder);
    free(controller);
    return NULL;
  }
  return controller;
}

void zuse_ghostty_mouse_controller_free(
    ZuseGhosttyMouseController *controller) {
  if (controller == NULL) return;
  ghostty_mouse_event_free(controller->event);
  ghostty_mouse_encoder_free(controller->encoder);
  free(controller);
}

void zuse_ghostty_mouse_controller_sync(
    ZuseGhosttyMouseController *controller,
    GhosttyTerminal terminal) {
  if (controller == NULL || terminal == NULL) return;
  ghostty_mouse_encoder_setopt_from_terminal(controller->encoder, terminal);
}

void zuse_ghostty_mouse_controller_reset(
    ZuseGhosttyMouseController *controller) {
  if (controller == NULL) return;
  controller->button_pressed = false;
  ghostty_mouse_encoder_reset(controller->encoder);
}

GhosttyResult zuse_ghostty_mouse_encode(
    ZuseGhosttyMouseController *controller,
    GhosttyMouseAction action,
    GhosttyMouseButton button,
    uint16_t modifiers,
    float x,
    float y,
    uint32_t screen_width,
    uint32_t screen_height,
    uint32_t cell_width,
    uint32_t cell_height,
    char *output,
    size_t output_capacity,
    size_t *out_written) {
  if (controller == NULL || out_written == NULL ||
      action < GHOSTTY_MOUSE_ACTION_PRESS ||
      action > GHOSTTY_MOUSE_ACTION_MOTION ||
      button < GHOSTTY_MOUSE_BUTTON_UNKNOWN ||
      button > GHOSTTY_MOUSE_BUTTON_ELEVEN ||
      screen_width == 0 || screen_height == 0 ||
      cell_width == 0 || cell_height == 0 ||
      screen_width > 100000 || screen_height > 100000 ||
      !isfinite(x) || !isfinite(y)) {
    return GHOSTTY_INVALID_VALUE;
  }
  const bool tracked_button = button >= GHOSTTY_MOUSE_BUTTON_LEFT &&
      button <= GHOSTTY_MOUSE_BUTTON_MIDDLE;
  if (!controller->button_pressed && tracked_button &&
      (action == GHOSTTY_MOUSE_ACTION_MOTION ||
       action == GHOSTTY_MOUSE_ACTION_RELEASE)) {
    *out_written = 0;
    return GHOSTTY_SUCCESS;
  }

  const GhosttyMouseEncoderSize size = {
      .size = sizeof(GhosttyMouseEncoderSize),
      .screen_width = screen_width,
      .screen_height = screen_height,
      .cell_width = cell_width,
      .cell_height = cell_height,
      .padding_top = 0,
      .padding_bottom = 0,
      .padding_right = 0,
      .padding_left = 0,
  };
  ghostty_mouse_encoder_setopt(
      controller->encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_SIZE,
      &size);
  const bool any_button_pressed =
      action == GHOSTTY_MOUSE_ACTION_PRESS ||
      (action == GHOSTTY_MOUSE_ACTION_MOTION && controller->button_pressed);
  ghostty_mouse_encoder_setopt(
      controller->encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_ANY_BUTTON_PRESSED,
      &any_button_pressed);
  const bool track_last_cell = true;
  ghostty_mouse_encoder_setopt(
      controller->encoder,
      GHOSTTY_MOUSE_ENCODER_OPT_TRACK_LAST_CELL,
      &track_last_cell);

  ghostty_mouse_event_set_action(
      controller->event,
      action);
  if (button == GHOSTTY_MOUSE_BUTTON_UNKNOWN) {
    ghostty_mouse_event_clear_button(controller->event);
  } else {
    ghostty_mouse_event_set_button(
        controller->event,
        button);
  }
  ghostty_mouse_event_set_mods(
      controller->event,
      (GhosttyMods)(modifiers & 0x3ff));
  ghostty_mouse_event_set_position(
      controller->event,
      (GhosttyMousePosition){.x = x, .y = y});

  const GhosttyResult result = ghostty_mouse_encoder_encode(
      controller->encoder,
      controller->event,
      output,
      output_capacity,
      out_written);
  if (result == GHOSTTY_SUCCESS) {
    if (*out_written > 0 && action == GHOSTTY_MOUSE_ACTION_PRESS &&
        button >= GHOSTTY_MOUSE_BUTTON_LEFT &&
        button <= GHOSTTY_MOUSE_BUTTON_MIDDLE) {
      controller->button_pressed = true;
    } else if (action == GHOSTTY_MOUSE_ACTION_RELEASE) {
      controller->button_pressed = false;
    }
  } else if (action == GHOSTTY_MOUSE_ACTION_RELEASE &&
             result != GHOSTTY_OUT_OF_SPACE) {
    controller->button_pressed = false;
  }
  return result;
}

void zuse_ghostty_scroll_rows(GhosttyTerminal terminal, intptr_t rows) {
  GhosttyTerminalScrollViewport viewport = {0};
  viewport.tag = GHOSTTY_SCROLL_VIEWPORT_DELTA;
  viewport.value.delta = rows;
  ghostty_terminal_scroll_viewport(terminal, viewport);
}

GhosttyResult zuse_ghostty_viewport_grid_ref(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    GhosttyGridRef *out_ref) {
  GhosttyPoint point = {0};
  point.tag = GHOSTTY_POINT_TAG_VIEWPORT;
  point.value.coordinate.x = x;
  point.value.coordinate.y = y;
  if (out_ref != NULL) out_ref->size = sizeof(*out_ref);
  return ghostty_terminal_grid_ref(terminal, point, out_ref);
}

GhosttyResult zuse_ghostty_viewport_hyperlink(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    uint8_t *output,
    size_t output_capacity,
    size_t *out_written) {
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult result = zuse_ghostty_viewport_grid_ref(terminal, x, y, &ref);
  if (result != GHOSTTY_SUCCESS) return result;
  return ghostty_grid_ref_hyperlink_uri(
      &ref,
      output,
      output_capacity,
      out_written);
}

static GhosttyResult zuse_ghostty_install_selection(
    GhosttyTerminal terminal,
    GhosttyResult result,
    GhosttySelection *selection) {
  if (result != GHOSTTY_SUCCESS) return result;
  return ghostty_terminal_set(
      terminal,
      GHOSTTY_TERMINAL_OPT_SELECTION,
      selection);
}

ZuseGhosttySelectionController *zuse_ghostty_selection_controller_new(void) {
  ZuseGhosttySelectionController *controller = calloc(1, sizeof(*controller));
  if (controller == NULL) return NULL;
  if (ghostty_selection_gesture_new(NULL, &controller->gesture) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(
          NULL,
          &controller->press,
          GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_PRESS) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(
          NULL,
          &controller->drag,
          GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_DRAG) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(
          NULL,
          &controller->autoscroll_tick,
          GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_AUTOSCROLL_TICK) != GHOSTTY_SUCCESS ||
      ghostty_selection_gesture_event_new(
          NULL,
          &controller->release,
          GHOSTTY_SELECTION_GESTURE_EVENT_TYPE_RELEASE) != GHOSTTY_SUCCESS) {
    ghostty_selection_gesture_event_free(controller->release);
    ghostty_selection_gesture_event_free(controller->autoscroll_tick);
    ghostty_selection_gesture_event_free(controller->drag);
    ghostty_selection_gesture_event_free(controller->press);
    ghostty_selection_gesture_free(controller->gesture, NULL);
    free(controller);
    return NULL;
  }
  return controller;
}

void zuse_ghostty_selection_controller_free(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal) {
  if (controller == NULL) return;
  ghostty_selection_gesture_event_free(controller->release);
  ghostty_selection_gesture_event_free(controller->autoscroll_tick);
  ghostty_selection_gesture_event_free(controller->drag);
  ghostty_selection_gesture_event_free(controller->press);
  ghostty_selection_gesture_free(controller->gesture, terminal);
  free(controller);
}

void zuse_ghostty_selection_controller_reset(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal) {
  if (controller == NULL) return;
  ghostty_selection_gesture_reset(controller->gesture, terminal);
}

GhosttyResult zuse_ghostty_selection_press(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    double surface_x,
    double surface_y,
    uint64_t time_ns) {
  if (controller == NULL || terminal == NULL) return GHOSTTY_INVALID_VALUE;
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult result = zuse_ghostty_viewport_grid_ref(terminal, x, y, &ref);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttySurfacePosition position = {.x = surface_x, .y = surface_y};
  double repeat_distance = 5;
  uint64_t repeat_interval_ns = 500000000;
  ghostty_terminal_set(terminal, GHOSTTY_TERMINAL_OPT_SELECTION, NULL);
  if ((result = ghostty_selection_gesture_event_set(
           controller->press,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
           &ref)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->press,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
           &position)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->press,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_DISTANCE,
           &repeat_distance)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->press,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_TIME_NS,
           &time_ns)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->press,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REPEAT_INTERVAL_NS,
           &repeat_interval_ns)) != GHOSTTY_SUCCESS) {
    return result;
  }
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  return zuse_ghostty_install_selection(
      terminal,
      ghostty_selection_gesture_event(
          controller->gesture,
          terminal,
          controller->press,
          &selection),
      &selection);
}

GhosttyResult zuse_ghostty_selection_drag(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    double surface_x,
    double surface_y,
    bool rectangle,
    uint32_t columns,
    uint32_t cell_width,
    uint32_t padding_left,
    uint32_t screen_height) {
  if (controller == NULL || terminal == NULL || columns == 0 ||
      cell_width == 0 || screen_height == 0) {
    return GHOSTTY_INVALID_VALUE;
  }
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult result = zuse_ghostty_viewport_grid_ref(terminal, x, y, &ref);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttySurfacePosition position = {.x = surface_x, .y = surface_y};
  GhosttySelectionGestureGeometry geometry = {
      .columns = columns,
      .cell_width = cell_width,
      .padding_left = padding_left,
      .screen_height = screen_height,
  };
  if ((result = ghostty_selection_gesture_event_set(
           controller->drag,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
           &ref)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->drag,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
           &position)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->drag,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_RECTANGLE,
           &rectangle)) != GHOSTTY_SUCCESS ||
      (result = ghostty_selection_gesture_event_set(
           controller->drag,
           GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY,
           &geometry)) != GHOSTTY_SUCCESS) {
    return result;
  }
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  return zuse_ghostty_install_selection(
      terminal,
      ghostty_selection_gesture_event(
          controller->gesture,
          terminal,
          controller->drag,
          &selection),
      &selection);
}

GhosttyResult zuse_ghostty_selection_autoscroll_tick(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal,
    uint16_t viewport_x,
    uint32_t viewport_y,
    double surface_x,
    double surface_y,
    bool rectangle,
    uint32_t columns,
    uint32_t cell_width,
    uint32_t padding_left,
    uint32_t screen_height) {
  if (controller == NULL || terminal == NULL || columns == 0 ||
      cell_width == 0 || screen_height == 0) {
    return GHOSTTY_INVALID_VALUE;
  }
  GhosttyPointCoordinate viewport = {.x = viewport_x, .y = viewport_y};
  GhosttySurfacePosition position = {.x = surface_x, .y = surface_y};
  GhosttySelectionGestureGeometry geometry = {
      .columns = columns,
      .cell_width = cell_width,
      .padding_left = padding_left,
      .screen_height = screen_height,
  };
  GhosttyResult result = ghostty_selection_gesture_event_set(
      controller->autoscroll_tick,
      GHOSTTY_SELECTION_GESTURE_EVENT_OPT_VIEWPORT,
      &viewport);
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_selection_gesture_event_set(
        controller->autoscroll_tick,
        GHOSTTY_SELECTION_GESTURE_EVENT_OPT_POSITION,
        &position);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_selection_gesture_event_set(
        controller->autoscroll_tick,
        GHOSTTY_SELECTION_GESTURE_EVENT_OPT_RECTANGLE,
        &rectangle);
  }
  if (result == GHOSTTY_SUCCESS) {
    result = ghostty_selection_gesture_event_set(
        controller->autoscroll_tick,
        GHOSTTY_SELECTION_GESTURE_EVENT_OPT_GEOMETRY,
        &geometry);
  }
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  return zuse_ghostty_install_selection(
      terminal,
      ghostty_selection_gesture_event(
          controller->gesture,
          terminal,
          controller->autoscroll_tick,
          &selection),
      &selection);
}

void zuse_ghostty_selection_release(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    bool has_position) {
  if (controller == NULL || terminal == NULL) return;
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  const GhosttyResult ref_result = has_position
      ? zuse_ghostty_viewport_grid_ref(terminal, x, y, &ref)
      : GHOSTTY_NO_VALUE;
  ghostty_selection_gesture_event_set(
      controller->release,
      GHOSTTY_SELECTION_GESTURE_EVENT_OPT_REF,
      ref_result == GHOSTTY_SUCCESS ? &ref : NULL);
  ghostty_selection_gesture_event(
      controller->gesture,
      terminal,
      controller->release,
      NULL);
}

GhosttyResult zuse_ghostty_select_word(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y) {
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult result = zuse_ghostty_viewport_grid_ref(terminal, x, y, &ref);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttyTerminalSelectWordOptions options = GHOSTTY_INIT_SIZED(
      GhosttyTerminalSelectWordOptions);
  options.ref = ref;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  return zuse_ghostty_install_selection(
      terminal,
      ghostty_terminal_select_word(terminal, &options, &selection),
      &selection);
}

GhosttyResult zuse_ghostty_select_line(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y) {
  GhosttyGridRef ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
  GhosttyResult result = zuse_ghostty_viewport_grid_ref(terminal, x, y, &ref);
  if (result != GHOSTTY_SUCCESS) return result;
  GhosttyTerminalSelectLineOptions options = GHOSTTY_INIT_SIZED(
      GhosttyTerminalSelectLineOptions);
  options.ref = ref;
  options.semantic_prompt_boundary = true;
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  return zuse_ghostty_install_selection(
      terminal,
      ghostty_terminal_select_line(terminal, &options, &selection),
      &selection);
}

GhosttyResult zuse_ghostty_select_all(GhosttyTerminal terminal) {
  GhosttySelection selection = GHOSTTY_INIT_SIZED(GhosttySelection);
  return zuse_ghostty_install_selection(
      terminal,
      ghostty_terminal_select_all(terminal, &selection),
      &selection);
}

GhosttyResult zuse_ghostty_selection_text(
    GhosttyTerminal terminal,
    uint8_t *output,
    size_t output_capacity,
    size_t *out_written) {
  GhosttyTerminalSelectionFormatOptions options = GHOSTTY_INIT_SIZED(
      GhosttyTerminalSelectionFormatOptions);
  options.emit = GHOSTTY_FORMATTER_FORMAT_PLAIN;
  options.unwrap = true;
  options.trim = true;
  return ghostty_terminal_selection_format_buf(
      terminal,
      options,
      output,
      output_capacity,
      out_written);
}
