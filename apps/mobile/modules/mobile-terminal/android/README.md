# Zuse Android terminal

The Android terminal is an Expo native view backed by the exact upstream
Ghostty revision in `native/libghostty-vt/VERSION`. Gradle runs
`scripts/build-ghostty-android.mjs`, which verifies that revision and builds a
static `libghostty-vt` archive before linking the JNI view.

Set `ANDROID_NDK_HOME` when invoking the build outside Android Studio or EAS.
The build uses Zig 0.15.2 and the Android NDK supplied by the app build. If Zig
is not already configured, the script downloads the host archive and verifies
its official SHA-256 digest before extraction.

The supported ABIs are `arm64-v8a` and `x86_64`. Application builds must set
`reactNativeArchitectures=arm64-v8a,x86_64`; the module rejects other targets
instead of producing an APK with a missing native library.

The Zig target names deliberately include `.24`, matching the app's minimum
Android API. Zig then emits its bundled emulated-TLS runtime on API 24. Removing
that suffix silently selects Android-Q native ELF TLS on x86_64 and makes the
final NDK link fail with an unresolved `__tls_get_addr`.
