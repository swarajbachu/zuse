#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <ghostty/vt.h>

#include "../ZuseGhosttySupport.h"

static void write_bytes(GhosttyTerminal terminal, const char *bytes) {
  ghostty_terminal_vt_write(
      terminal,
      (const uint8_t *)bytes,
      strlen(bytes));
}

static void expect_reply(
    ZuseGhosttyOutputQueue *queue,
    const char *expected) {
  const size_t capacity = zuse_ghostty_output_queue_length(queue);
  uint8_t *reply = malloc(capacity + 1);
  assert(reply != NULL);
  size_t written = 0;
  assert(zuse_ghostty_output_queue_take(
             queue,
             reply,
             capacity,
             &written) == GHOSTTY_SUCCESS);
  reply[written] = 0;
  assert(strcmp((const char *)reply, expected) == 0);
  free(reply);
}

static char *encode_key(
    GhosttyKeyEncoder encoder,
    GhosttyKeyEvent event,
    size_t *out_length) {
  size_t required = 0;
  assert(ghostty_key_encoder_encode(
             encoder,
             event,
             NULL,
             0,
             &required) == GHOSTTY_OUT_OF_SPACE);
  char *output = malloc(required + 1);
  assert(output != NULL);
  assert(ghostty_key_encoder_encode(
             encoder,
             event,
             output,
             required,
             out_length) == GHOSTTY_SUCCESS);
  output[*out_length] = 0;
  return output;
}

static char *encode_focus(
    ZuseGhosttyFocusController *controller,
    GhosttyTerminal terminal,
    bool focused,
    size_t *out_length) {
  size_t required = 0;
  const GhosttyResult sizing = zuse_ghostty_focus_controller_encode(
      controller,
      terminal,
      focused,
      NULL,
      0,
      &required);
  if (sizing == GHOSTTY_SUCCESS) {
    assert(required == 0);
    char *output = calloc(1, 1);
    assert(output != NULL);
    *out_length = 0;
    return output;
  }
  assert(sizing == GHOSTTY_OUT_OF_SPACE);
  assert(required > 0);
  char *output = malloc(required + 1);
  assert(output != NULL);
  assert(zuse_ghostty_focus_controller_encode(
             controller,
             terminal,
             focused,
             output,
             required,
             out_length) == GHOSTTY_SUCCESS);
  output[*out_length] = 0;
  return output;
}

static void expect_focus(
    ZuseGhosttyFocusController *controller,
    GhosttyTerminal terminal,
    bool focused,
    const char *expected) {
  size_t length = 0;
  char *encoded = encode_focus(controller, terminal, focused, &length);
  assert(length == strlen(expected));
  assert(memcmp(encoded, expected, length) == 0);
  free(encoded);
}

static char *encode_mouse(
    ZuseGhosttyMouseController *controller,
    GhosttyMouseAction action,
    GhosttyMouseButton button,
    uint16_t modifiers,
    float x,
    float y,
    size_t *out_length) {
  size_t required = 0;
  GhosttyResult result = zuse_ghostty_mouse_encode(
      controller,
      action,
      button,
      modifiers,
      x,
      y,
      800,
      400,
      8,
      16,
      NULL,
      0,
      &required);
  if (result == GHOSTTY_SUCCESS) {
    assert(required == 0);
    char *output = calloc(1, 1);
    assert(output != NULL);
    *out_length = 0;
    return output;
  }
  assert(result == GHOSTTY_OUT_OF_SPACE);
  assert(required > 0 && required <= 128);

  char *output = malloc(required + 1);
  assert(output != NULL);
  assert(zuse_ghostty_mouse_encode(
             controller,
             action,
             button,
             modifiers,
             x,
             y,
             800,
             400,
             8,
             16,
             output,
             required,
             out_length) == GHOSTTY_SUCCESS);
  output[*out_length] = 0;
  return output;
}

static void expect_mouse(
    ZuseGhosttyMouseController *controller,
    GhosttyMouseAction action,
    GhosttyMouseButton button,
    uint16_t modifiers,
    float x,
    float y,
    const char *expected) {
  size_t length = 0;
  char *encoded = encode_mouse(
      controller,
      action,
      button,
      modifiers,
      x,
      y,
      &length);
  assert(length == strlen(expected));
  assert(memcmp(encoded, expected, length) == 0);
  free(encoded);
}

int main(void) {
  GhosttyTerminal terminal = NULL;
  GhosttyTerminalOptions options = {
      .cols = 20,
      .rows = 4,
      .max_scrollback = 100,
  };
  assert(ghostty_terminal_new(NULL, &terminal, options) == GHOSTTY_SUCCESS);

  ZuseGhosttyOutputQueue *queue = zuse_ghostty_output_queue_new();
  assert(queue != NULL);
  assert(zuse_ghostty_output_queue_install(queue, terminal) == GHOSTTY_SUCCESS);
  zuse_ghostty_output_queue_set_size(queue, 20, 4, 16, 32);

  write_bytes(terminal, "\x1b[6n");
  expect_reply(queue, "\x1b[1;1R");
  write_bytes(terminal, "\x1b[18t");
  expect_reply(queue, "\x1b[8;4;20t");
  write_bytes(terminal, "\x1b[16t");
  expect_reply(queue, "\x1b[6;32;16t");
  write_bytes(terminal, "\x1b[14t");
  expect_reply(queue, "\x1b[4;128;320t");
  write_bytes(terminal, "\x1b[?996n");
  expect_reply(queue, "\x1b[?997;1n");
  write_bytes(terminal, "\x1b[c");
  expect_reply(queue, "\x1b[?62;22c");

  GhosttyKeyEncoder encoder = NULL;
  GhosttyKeyEvent event = NULL;
  assert(ghostty_key_encoder_new(NULL, &encoder) == GHOSTTY_SUCCESS);
  assert(ghostty_key_event_new(NULL, &event) == GHOSTTY_SUCCESS);
  write_bytes(terminal, "\x1b[?1h");
  ghostty_key_encoder_setopt_from_terminal(encoder, terminal);
  ghostty_key_event_set_action(event, GHOSTTY_KEY_ACTION_PRESS);
  ghostty_key_event_set_key(event, GHOSTTY_KEY_ARROW_UP);
  size_t key_length = 0;
  char *key = encode_key(encoder, event, &key_length);
  assert(key_length == 3);
  assert(memcmp(key, "\x1bOA", key_length) == 0);
  free(key);

  write_bytes(terminal, "\x1b[?1004h");
  size_t focus_length = 0;
  assert(zuse_ghostty_encode_focus(
             terminal,
             true,
             NULL,
             0,
             &focus_length) == GHOSTTY_OUT_OF_SPACE);
  char focus[8] = {0};
  assert(zuse_ghostty_encode_focus(
             terminal,
             true,
             focus,
             sizeof(focus),
             &focus_length) == GHOSTTY_SUCCESS);
  assert(focus_length == 3);
  assert(memcmp(focus, "\x1b[I", focus_length) == 0);

  ZuseGhosttyFocusController *focus_controller =
      zuse_ghostty_focus_controller_new();
  assert(focus_controller != NULL);
  expect_focus(focus_controller, terminal, true, "\x1b[I");
  expect_focus(focus_controller, terminal, true, "");
  const char reset_and_reenable_focus[] = "\x1b" "c\x1b[?1004h";
  zuse_ghostty_focus_controller_observe_vt_input(
      focus_controller,
      (const uint8_t *)reset_and_reenable_focus,
      sizeof(reset_and_reenable_focus) - 1);
  write_bytes(terminal, reset_and_reenable_focus);
  expect_focus(focus_controller, terminal, true, "\x1b[I");

  write_bytes(terminal, "\x1b[?2004h");
  char paste[] = "hello\nworld\x1b";
  size_t paste_length = 0;
  assert(zuse_ghostty_encode_paste(
             terminal,
             paste,
             sizeof(paste) - 1,
             NULL,
             0,
             &paste_length) == GHOSTTY_OUT_OF_SPACE);
  char *encoded_paste = malloc(paste_length + 1);
  assert(encoded_paste != NULL);
  assert(zuse_ghostty_encode_paste(
             terminal,
             paste,
             sizeof(paste) - 1,
             encoded_paste,
             paste_length,
             &paste_length) == GHOSTTY_SUCCESS);
  encoded_paste[paste_length] = 0;
  assert(strcmp(encoded_paste, "\x1b[200~hello\nworld \x1b[201~") == 0);
  free(encoded_paste);

  ghostty_terminal_reset(terminal);
  char plain_paste[] = "one\ntwo";
  size_t plain_length = 0;
  assert(zuse_ghostty_encode_paste(
             terminal,
             plain_paste,
             sizeof(plain_paste) - 1,
             NULL,
             0,
             &plain_length) == GHOSTTY_OUT_OF_SPACE);
  char plain_output[16] = {0};
  assert(zuse_ghostty_encode_paste(
             terminal,
             plain_paste,
             sizeof(plain_paste) - 1,
             plain_output,
             sizeof(plain_output),
             &plain_length) == GHOSTTY_SUCCESS);
  assert(plain_length == 7);
  assert(memcmp(plain_output, "one\rtwo", plain_length) == 0);

  ZuseGhosttyMouseController *mouse_controller =
      zuse_ghostty_mouse_controller_new();
  assert(mouse_controller != NULL);
  write_bytes(terminal, "\x1b[?1002h\x1b[?1006h");
  zuse_ghostty_mouse_controller_sync(mouse_controller, terminal);
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_MOTION,
      GHOSTTY_MOUSE_BUTTON_UNKNOWN,
      0,
      0,
      0,
      "");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      0,
      0,
      "\x1b[<0;1;1M");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_MOTION,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      16,
      0,
      "\x1b[<32;3;1M");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_RELEASE,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      16,
      0,
      "\x1b[<0;3;1m");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_MOTION,
      GHOSTTY_MOUSE_BUTTON_UNKNOWN,
      0,
      24,
      0,
      "");

  write_bytes(terminal, "\x1b[?1002l\x1b[?1003h");
  zuse_ghostty_mouse_controller_sync(mouse_controller, terminal);
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_MOTION,
      GHOSTTY_MOUSE_BUTTON_UNKNOWN,
      0,
      24,
      0,
      "\x1b[<35;4;1M");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_RIGHT,
      GHOSTTY_MODS_CTRL,
      0,
      0,
      "\x1b[<18;1;1M");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_RELEASE,
      GHOSTTY_MOUSE_BUTTON_RIGHT,
      GHOSTTY_MODS_CTRL,
      0,
      0,
      "\x1b[<18;1;1m");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_MIDDLE,
      0,
      0,
      0,
      "\x1b[<1;1;1M");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_RELEASE,
      GHOSTTY_MOUSE_BUTTON_MIDDLE,
      0,
      0,
      0,
      "\x1b[<1;1;1m");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_FOUR,
      0,
      0,
      0,
      "\x1b[<64;1;1M");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_FIVE,
      0,
      0,
      0,
      "\x1b[<65;1;1M");

  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      0,
      0,
      "\x1b[<0;1;1M");
  const char reset_and_reenable_mouse[] =
      "\x1b" "c\x1b[?1002h\x1b[?1006h";
  assert(zuse_ghostty_focus_controller_observe_vt_input(
      focus_controller,
      (const uint8_t *)reset_and_reenable_mouse,
      sizeof(reset_and_reenable_mouse) - 1));
  zuse_ghostty_mouse_controller_reset(mouse_controller);
  write_bytes(terminal, reset_and_reenable_mouse);
  zuse_ghostty_mouse_controller_sync(mouse_controller, terminal);
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_MOTION,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      16,
      0,
      "");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_RELEASE,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      16,
      0,
      "");
  expect_mouse(
      mouse_controller,
      GHOSTTY_MOUSE_ACTION_PRESS,
      GHOSTTY_MOUSE_BUTTON_LEFT,
      0,
      16,
      0,
      "\x1b[<0;3;1M");

  write_bytes(terminal, "\x1b]8;;https://zuse.sh\x07hello\x1b]8;;\x07 world");
  size_t link_length = 0;
  assert(zuse_ghostty_viewport_hyperlink(
             terminal,
             1,
             0,
             NULL,
             0,
             &link_length) == GHOSTTY_OUT_OF_SPACE);
  uint8_t *link = malloc(link_length + 1);
  assert(link != NULL);
  assert(zuse_ghostty_viewport_hyperlink(
             terminal,
             1,
             0,
             link,
             link_length,
             &link_length) == GHOSTTY_SUCCESS);
  link[link_length] = 0;
  assert(strcmp((char *)link, "https://zuse.sh") == 0);
  free(link);

  ZuseGhosttySelectionController *selection_controller =
      zuse_ghostty_selection_controller_new();
  assert(selection_controller != NULL);
  assert(zuse_ghostty_selection_press(
             selection_controller,
             terminal,
             0,
             0,
             0,
             0,
             1) == GHOSTTY_NO_VALUE);
  assert(zuse_ghostty_selection_drag(
             selection_controller,
             terminal,
             4,
             0,
             75,
             0,
             false,
             20,
             16,
             0,
             128) == GHOSTTY_SUCCESS);
  zuse_ghostty_selection_release(selection_controller, terminal, 4, 0, true);
  size_t drag_selection_length = 0;
  assert(zuse_ghostty_selection_text(
             terminal,
             NULL,
             0,
             &drag_selection_length) == GHOSTTY_OUT_OF_SPACE);
  uint8_t drag_selection[16] = {0};
  assert(zuse_ghostty_selection_text(
             terminal,
             drag_selection,
             sizeof(drag_selection),
             &drag_selection_length) == GHOSTTY_SUCCESS);
  assert(drag_selection_length == 5);
  assert(memcmp(drag_selection, "hello", drag_selection_length) == 0);

  assert(zuse_ghostty_select_word(terminal, 7, 0) == GHOSTTY_SUCCESS);
  size_t selection_length = 0;
  assert(zuse_ghostty_selection_text(
             terminal,
             NULL,
             0,
             &selection_length) == GHOSTTY_OUT_OF_SPACE);
  uint8_t *selection = malloc(selection_length + 1);
  assert(selection != NULL);
  assert(zuse_ghostty_selection_text(
             terminal,
             selection,
             selection_length,
             &selection_length) == GHOSTTY_SUCCESS);
  selection[selection_length] = 0;
  assert(strcmp((char *)selection, "world") == 0);
  free(selection);

  ghostty_key_event_free(event);
  ghostty_key_encoder_free(encoder);
  zuse_ghostty_mouse_controller_free(mouse_controller);
  zuse_ghostty_focus_controller_free(focus_controller);
  zuse_ghostty_selection_controller_free(selection_controller, terminal);
  ghostty_terminal_free(terminal);
  zuse_ghostty_output_queue_free(queue);
  puts("host Ghostty VT behavior check passed");
  return 0;
}
