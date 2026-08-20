#pragma once

#include <cstddef>
#include <utility>

namespace emscripten {

struct memory_view_stub {
    std::size_t size{};
    const void* data{};
};

template <class T>
memory_view_stub typed_memory_view(std::size_t size, T* data)
{
    return {size, data};
}

class val {
public:
    val() = default;

    static val global(const char*) { return {}; }
    static val null() { return {}; }
    static val object() { return {}; }

    template <class... Args>
    val new_(Args&&...) const { return {}; }

    template <class T>
    void set(const char*, T&&) {}
};

} // namespace emscripten
