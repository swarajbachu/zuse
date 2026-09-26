#!/bin/sh
# Zig 0.15.2 needs arm64 (not only arm64e) macOS SDK stubs for its host
# build runner. Keep every iOS SDK and other Xcode operation unchanged.
if [ "$#" = 3 ] && [ "$1" = --sdk ] && [ "$2" = macosx ] && [ "$3" = --show-sdk-path ]; then
  DEVELOPER_DIR=/Library/Developer/CommandLineTools exec /usr/bin/xcrun "$@"
fi
exec /usr/bin/xcrun "$@"
