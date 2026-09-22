#ifndef ZUSE_GHOSTTY_SUPPORT_H
#define ZUSE_GHOSTTY_SUPPORT_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <ghostty/vt.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Small, allocation-owning adapter around libghostty-vt operations whose C
 * value ABI is awkward to express safely through Swift's Clang importer.
 * Terminal emulation remains exclusively owned by libghostty-vt.
 */
typedef struct ZuseGhosttyOutputQueue ZuseGhosttyOutputQueue;
typedef struct ZuseGhosttyFocusController ZuseGhosttyFocusController;
typedef struct ZuseGhosttyMouseController ZuseGhosttyMouseController;
typedef struct ZuseGhosttySelectionController ZuseGhosttySelectionController;

ZuseGhosttyOutputQueue *zuse_ghostty_output_queue_new(void);
void zuse_ghostty_output_queue_free(ZuseGhosttyOutputQueue *queue);
GhosttyResult zuse_ghostty_output_queue_install(
    ZuseGhosttyOutputQueue *queue,
    GhosttyTerminal terminal);
void zuse_ghostty_output_queue_set_size(
    ZuseGhosttyOutputQueue *queue,
    uint16_t columns,
    uint16_t rows,
    uint32_t cell_width,
    uint32_t cell_height);
size_t zuse_ghostty_output_queue_length(const ZuseGhosttyOutputQueue *queue);
GhosttyResult zuse_ghostty_output_queue_take(
    ZuseGhosttyOutputQueue *queue,
    uint8_t *buffer,
    size_t capacity,
    size_t *out_written);

GhosttyResult zuse_ghostty_encode_paste(
    GhosttyTerminal terminal,
    char *input,
    size_t input_length,
    char *output,
    size_t output_capacity,
    size_t *out_written);
GhosttyResult zuse_ghostty_encode_focus(
    GhosttyTerminal terminal,
    bool focused,
    char *output,
    size_t output_capacity,
    size_t *out_written);
bool zuse_ghostty_focus_reporting_enabled(GhosttyTerminal terminal);
ZuseGhosttyFocusController *zuse_ghostty_focus_controller_new(void);
void zuse_ghostty_focus_controller_free(
    ZuseGhosttyFocusController *controller);
void zuse_ghostty_focus_controller_reset(
    ZuseGhosttyFocusController *controller);
bool zuse_ghostty_focus_controller_observe_vt_input(
    ZuseGhosttyFocusController *controller,
    const uint8_t *input,
    size_t input_length);
GhosttyResult zuse_ghostty_focus_controller_encode(
    ZuseGhosttyFocusController *controller,
    GhosttyTerminal terminal,
    bool focused,
    char *output,
    size_t output_capacity,
    size_t *out_written);
void zuse_ghostty_key_event_set_key_code(
    GhosttyKeyEvent event,
    int32_t key_code);

ZuseGhosttyMouseController *zuse_ghostty_mouse_controller_new(void);
void zuse_ghostty_mouse_controller_free(
    ZuseGhosttyMouseController *controller);
void zuse_ghostty_mouse_controller_sync(
    ZuseGhosttyMouseController *controller,
    GhosttyTerminal terminal);
void zuse_ghostty_mouse_controller_reset(
    ZuseGhosttyMouseController *controller);
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
    size_t *out_written);

void zuse_ghostty_scroll_rows(GhosttyTerminal terminal, intptr_t rows);
GhosttyResult zuse_ghostty_viewport_grid_ref(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    GhosttyGridRef *out_ref);
GhosttyResult zuse_ghostty_viewport_hyperlink(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    uint8_t *output,
    size_t output_capacity,
    size_t *out_written);

ZuseGhosttySelectionController *zuse_ghostty_selection_controller_new(void);
void zuse_ghostty_selection_controller_free(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal);
void zuse_ghostty_selection_controller_reset(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal);
GhosttyResult zuse_ghostty_selection_press(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    double surface_x,
    double surface_y,
    uint64_t time_ns);
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
    uint32_t screen_height);
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
    uint32_t screen_height);
void zuse_ghostty_selection_release(
    ZuseGhosttySelectionController *controller,
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y,
    bool has_position);
GhosttyResult zuse_ghostty_select_word(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y);
GhosttyResult zuse_ghostty_select_line(
    GhosttyTerminal terminal,
    uint16_t x,
    uint32_t y);
GhosttyResult zuse_ghostty_select_all(GhosttyTerminal terminal);
GhosttyResult zuse_ghostty_selection_text(
    GhosttyTerminal terminal,
    uint8_t *output,
    size_t output_capacity,
    size_t *out_written);

#ifdef __cplusplus
}
#endif

#endif
