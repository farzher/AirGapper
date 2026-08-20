cmake_minimum_required(VERSION 3.22.1)
project(airgapper_native LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

include(FetchContent)

set(ZXING_READERS ON CACHE BOOL "" FORCE)
set(ZXING_WRITERS OFF CACHE BOOL "" FORCE)
set(ZXING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(ZXING_BLACKBOX_TESTS OFF CACHE BOOL "" FORCE)
set(ZXING_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(ZXING_PYTHON_MODULE OFF CACHE BOOL "" FORCE)
set(ZXING_C_API OFF CACHE BOOL "" FORCE)
set(ZXING_EXPERIMENTAL_API OFF CACHE BOOL "" FORCE)
set(ZXING_ENABLE_1D OFF CACHE BOOL "" FORCE)
set(ZXING_ENABLE_AZTEC OFF CACHE BOOL "" FORCE)
set(ZXING_ENABLE_DATAMATRIX OFF CACHE BOOL "" FORCE)
set(ZXING_ENABLE_MAXICODE OFF CACHE BOOL "" FORCE)
set(ZXING_ENABLE_PDF417 OFF CACHE BOOL "" FORCE)
set(ZXING_ENABLE_QRCODE ON CACHE BOOL "" FORCE)

FetchContent_Declare(
    zxing
    GIT_REPOSITORY https://github.com/zxing-cpp/zxing-cpp.git
    GIT_TAG 3e09874a9ca7c191d67101f302a1f53c71a118cc
    SOURCE_SUBDIR core
)
FetchContent_MakeAvailable(zxing)

set(AIRGAPPER_ROOT "${CMAKE_CURRENT_LIST_DIR}/../../../../..")
set(AIRGAPPER_CODEC_DIR "${AIRGAPPER_ROOT}/codec/source/wrapper")

add_library(
    airgapper_native
    SHARED
    airgapper_native_jni.cpp
    "${AIRGAPPER_CODEC_DIR}/airgapper_codec.cpp"
)

target_include_directories(airgapper_native PRIVATE
    "${CMAKE_CURRENT_LIST_DIR}"
    "${AIRGAPPER_CODEC_DIR}"
    "${zxing_SOURCE_DIR}/core/src"
)

target_compile_definitions(airgapper_native PRIVATE
    AIRGAPPER_NATIVE=1
    ZXING_INTERNAL=1
    AIRGAPPER_CODEC_VERSION="0.2.1"
    AIRGAPPER_CODEC_BUILD="android"
)

# AirGapper intentionally uses a handful of zxing-cpp QR internals for the
# calibrated Guided path. Export those declarations from the QR-only static
# library exactly as the WASM build does.
if(TARGET ZXing)
    target_compile_definitions(ZXing PRIVATE ZXING_BUILD_FOR_TEST=1)
endif()

target_compile_options(airgapper_native PRIVATE -O3)

target_link_libraries(airgapper_native PRIVATE ZXing::ZXing log)