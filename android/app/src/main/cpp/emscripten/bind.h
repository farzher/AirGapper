#pragma once

#include "val.h"

namespace emscripten {

template <class T>
class value_object {
public:
    explicit value_object(const char*) {}

    template <class Field>
    value_object& field(const char*, Field) { return *this; }
};

template <class T>
void register_vector(const char*) {}

template <class Fn>
void function(const char*, Fn) {}

template <std::size_t I>
struct index_tag {};

template <std::size_t I>
constexpr index_tag<I> index() { return {}; }

} // namespace emscripten

#define EMSCRIPTEN_BINDINGS(name) static void emscripten_bindings_##name()
