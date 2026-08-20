#pragma once

// Minimal compatibility surface for compiling the shared AirGapper codec
// under the Android NDK. Browser builds still use Emscripten's real header.
#include <chrono>

#ifndef EMSCRIPTEN_KEEPALIVE
#define EMSCRIPTEN_KEEPALIVE
#endif

inline double emscripten_get_now()
{
    using clock = std::chrono::steady_clock;
    static const auto origin = clock::now();
    return std::chrono::duration<double, std::milli>(clock::now() - origin).count();
}