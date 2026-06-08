cmake_minimum_required(VERSION 3.20)

project(ocio_js_wasm LANGUAGES CXX)

if(NOT EMSCRIPTEN)
    message(FATAL_ERROR "ocio-js must be built with Emscripten. Use scripts/build-wasm.sh.")
endif()

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(OCIO_WASM_DIST_DIR "${CMAKE_SOURCE_DIR}/dist" CACHE PATH "Output directory for ocio-wasm.js and ocio-wasm.wasm")

find_package(OpenColorIO CONFIG REQUIRED)

add_executable(ocio-wasm src/native/ocio_bridge.cpp)
target_link_libraries(ocio-wasm PRIVATE OpenColorIO::OpenColorIO)
target_compile_options(ocio-wasm PRIVATE -fexceptions)

set(OCIO_WASM_EXPORTED_FUNCTIONS
    "['_malloc','_free',\
'_ocio_get_version','_ocio_get_version_hex','_ocio_get_last_error','_ocio_clear_all_caches',\
'_ocio_builtin_config_get_count','_ocio_builtin_config_get_name','_ocio_builtin_config_get_ui_name','_ocio_builtin_config_is_recommended','_ocio_builtin_config_get_yaml',\
'_ocio_config_create_builtin','_ocio_config_create_from_file','_ocio_config_create_from_string','_ocio_config_release','_ocio_config_validate','_ocio_config_get_major_version','_ocio_config_get_minor_version',\
'_ocio_config_get_num_roles','_ocio_config_get_role_name','_ocio_config_get_role_color_space',\
'_ocio_config_get_num_color_spaces','_ocio_config_get_color_space_name','_ocio_config_get_canonical_name','_ocio_config_get_color_space_family','_ocio_config_get_color_space_encoding','_ocio_config_get_color_space_description','_ocio_config_get_color_space_is_data','_ocio_config_get_color_space_reference_space','_ocio_config_get_num_color_space_aliases','_ocio_config_get_color_space_alias','_ocio_config_get_num_color_space_categories','_ocio_config_get_color_space_category',\
'_ocio_config_get_num_displays','_ocio_config_get_display','_ocio_config_get_default_display','_ocio_config_get_num_views','_ocio_config_get_view','_ocio_config_get_default_view','_ocio_config_get_default_view_for_color_space','_ocio_config_get_view_transform_name','_ocio_config_get_view_color_space_name','_ocio_config_get_view_looks','_ocio_config_get_view_description',\
'_ocio_config_get_num_looks','_ocio_config_get_look_name','_ocio_config_get_num_view_transforms','_ocio_config_get_view_transform_name_by_index','_ocio_config_get_num_named_transforms','_ocio_config_get_named_transform_name',\
'_ocio_processor_create_color_space','_ocio_processor_create_display_view','_ocio_processor_release','_ocio_processor_get_cache_id','_ocio_processor_is_noop','_ocio_processor_is_identity','_ocio_processor_apply_rgb_f32','_ocio_processor_apply_rgba_f32','_ocio_processor_apply_rgba_u8',\
'_ocio_processor_extract_gpu_shader_info','_ocio_processor_get_gpu_shader_text','_ocio_processor_get_gpu_shader_language','_ocio_processor_get_gpu_shader_function_name','_ocio_processor_get_gpu_shader_cache_id','_ocio_processor_get_gpu_shader_uniform_buffer_size',\
'_ocio_processor_get_gpu_shader_texture_count','_ocio_processor_get_gpu_shader_texture_name','_ocio_processor_get_gpu_shader_texture_sampler_name','_ocio_processor_get_gpu_shader_texture_width','_ocio_processor_get_gpu_shader_texture_height','_ocio_processor_get_gpu_shader_texture_depth','_ocio_processor_get_gpu_shader_texture_dimensions','_ocio_processor_get_gpu_shader_texture_channels','_ocio_processor_get_gpu_shader_texture_interpolation','_ocio_processor_get_gpu_shader_texture_value_count','_ocio_processor_get_gpu_shader_texture_values',\
'_ocio_processor_get_gpu_shader_uniform_count','_ocio_processor_get_gpu_shader_uniform_name','_ocio_processor_get_gpu_shader_uniform_type','_ocio_processor_get_gpu_shader_uniform_buffer_offset','_ocio_processor_get_gpu_shader_uniform_value_count','_ocio_processor_get_gpu_shader_uniform_value_f64','_ocio_processor_get_gpu_shader_uniform_value_i32']"
)

set(OCIO_WASM_RUNTIME_METHODS "['UTF8ToString','stringToUTF8','lengthBytesUTF8','FS','HEAPU8','HEAPF32']")

target_link_options(ocio-wasm PRIVATE
    -fexceptions
    "SHELL:-s WASM=1"
    "SHELL:-s MODULARIZE=1"
    "SHELL:-s EXPORT_ES6=1"
    "SHELL:-s EXPORT_NAME=createOcioWasmModule"
    "SHELL:-s ENVIRONMENT=web,worker,node"
    "SHELL:-s ALLOW_MEMORY_GROWTH=1"
    "SHELL:-s INITIAL_MEMORY=67108864"
    "SHELL:-s FILESYSTEM=1"
    "SHELL:-s DISABLE_EXCEPTION_CATCHING=0"
    "SHELL:-s EXPORTED_FUNCTIONS=${OCIO_WASM_EXPORTED_FUNCTIONS}"
    "SHELL:-s EXPORTED_RUNTIME_METHODS=${OCIO_WASM_RUNTIME_METHODS}"
)

set_target_properties(ocio-wasm PROPERTIES
    OUTPUT_NAME "ocio-wasm"
    SUFFIX ".js"
    RUNTIME_OUTPUT_DIRECTORY "${OCIO_WASM_DIST_DIR}"
)
