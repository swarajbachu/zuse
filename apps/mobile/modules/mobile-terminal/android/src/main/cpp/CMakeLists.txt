cmake_minimum_required(VERSION 3.22.1)
project(zuse_mobile_terminal LANGUAGES CXX)

if(NOT DEFINED ZUSE_GHOSTTY_VENDOR_DIR)
  set(ZUSE_GHOSTTY_VENDOR_DIR "${CMAKE_CURRENT_LIST_DIR}/../../../vendor")
endif()

set(GHOSTTY_LIBRARY
  "${ZUSE_GHOSTTY_VENDOR_DIR}/lib/${ANDROID_ABI}/libghostty-vt.a"
)
set(GHOSTTY_INCLUDE_DIR "${ZUSE_GHOSTTY_VENDOR_DIR}/include")

if(NOT EXISTS "${GHOSTTY_LIBRARY}")
  message(FATAL_ERROR
    "Missing ${GHOSTTY_LIBRARY}. Run scripts/build-ghostty-android.mjs first."
  )
endif()
if(NOT EXISTS "${GHOSTTY_INCLUDE_DIR}/ghostty/vt.h")
  message(FATAL_ERROR "Missing generated Ghostty headers in ${GHOSTTY_INCLUDE_DIR}")
endif()

add_library(ghostty-vt STATIC IMPORTED)
set_target_properties(ghostty-vt PROPERTIES IMPORTED_LOCATION "${GHOSTTY_LIBRARY}")

file(READ "${ZUSE_GHOSTTY_VENDOR_DIR}/REVISION" GHOSTTY_REVISION)
string(STRIP "${GHOSTTY_REVISION}" GHOSTTY_REVISION)

add_library(zuse-mobile-terminal SHARED zuse_terminal_jni.cpp)
target_include_directories(zuse-mobile-terminal PRIVATE "${GHOSTTY_INCLUDE_DIR}")
target_compile_features(zuse-mobile-terminal PRIVATE cxx_std_20)
target_compile_definitions(zuse-mobile-terminal PRIVATE
  GHOSTTY_STATIC=1
  ZUSE_GHOSTTY_REVISION="${GHOSTTY_REVISION}"
)
set(ZUSE_TERMINAL_VERSION_SCRIPT "${CMAKE_CURRENT_LIST_DIR}/zuse_terminal.map")
set_target_properties(zuse-mobile-terminal PROPERTIES
  LINK_DEPENDS "${ZUSE_TERMINAL_VERSION_SCRIPT}"
)
target_link_options(zuse-mobile-terminal PRIVATE
  "-Wl,-z,max-page-size=16384"
  "-Wl,--version-script=${ZUSE_TERMINAL_VERSION_SCRIPT}"
)
target_link_libraries(zuse-mobile-terminal PRIVATE ghostty-vt android log)
