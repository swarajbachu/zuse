extern "env" fn zuse_terminal_reply(
    terminal: u32,
    context: u32,
    bytes: u32,
    length: u32,
) void;

export fn zuse_ghostty_terminal_reply(
    terminal: u32,
    context: u32,
    bytes: u32,
    length: u32,
) void {
    zuse_terminal_reply(terminal, context, bytes, length);
}
