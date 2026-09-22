# libghostty-vt provenance

Zuse terminal renderers are built from the exact upstream Ghostty revision in
`VERSION`. `LICENSE` is the upstream license distributed with every generated
artifact.

Run `bun run build:ghostty:wasm` to reproduce the desktop WebAssembly artifact.
The build script uses Zig 0.15.2, verifies the checkout revision, embeds it in
Ghostty's build metadata, and writes only the resulting artifact into the
renderer package.
