#include <OpenColorIO/OpenColorIO.h>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <exception>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace OCIO = OCIO_NAMESPACE;

namespace
{
std::string g_lastError;
std::string g_stringResult;
int g_nextConfigHandle = 1;
int g_nextProcessorHandle = 1;

std::unordered_map<int, OCIO::ConstConfigRcPtr> g_configs;

struct ProcessorRecord
{
    OCIO::ConstProcessorRcPtr processor;
    OCIO::ConstCPUProcessorRcPtr cpuProcessor;
};

std::unordered_map<int, ProcessorRecord> g_processors;

void clearError()
{
    g_lastError.clear();
}

void setError(const char * message)
{
    g_lastError = message ? message : "Unknown OpenColorIO error";
}

void setError(const std::string & message)
{
    g_lastError = message;
}

const char * result(const char * value)
{
    g_stringResult = value ? value : "";
    return g_stringResult.c_str();
}

const char * result(const std::string & value)
{
    g_stringResult = value;
    return g_stringResult.c_str();
}

OCIO::ConstConfigRcPtr requireConfig(int handle)
{
    const auto it = g_configs.find(handle);
    if (it == g_configs.end())
    {
        std::ostringstream stream;
        stream << "Invalid OCIO config handle: " << handle;
        throw std::runtime_error(stream.str());
    }
    return it->second;
}

ProcessorRecord & requireProcessor(int handle)
{
    const auto it = g_processors.find(handle);
    if (it == g_processors.end())
    {
        std::ostringstream stream;
        stream << "Invalid OCIO processor handle: " << handle;
        throw std::runtime_error(stream.str());
    }
    return it->second;
}

OCIO::ConstColorSpaceRcPtr requireColorSpace(const OCIO::ConstConfigRcPtr & config, const char * name)
{
    OCIO::ConstColorSpaceRcPtr colorSpace = config->getColorSpace(name);
    if (!colorSpace)
    {
        std::ostringstream stream;
        stream << "Color space not found: " << (name ? name : "");
        throw std::runtime_error(stream.str());
    }
    return colorSpace;
}

int storeConfig(const OCIO::ConstConfigRcPtr & config)
{
    const int handle = g_nextConfigHandle++;
    g_configs.emplace(handle, config);
    return handle;
}

int storeProcessor(const OCIO::ConstProcessorRcPtr & processor, int optimizationFlags)
{
    ProcessorRecord record;
    record.processor = processor;

    if (optimizationFlags == std::numeric_limits<int>::min())
    {
        record.cpuProcessor = processor->getDefaultCPUProcessor();
    }
    else
    {
        record.cpuProcessor = processor->getOptimizedCPUProcessor(
            OCIO::BIT_DEPTH_F32,
            OCIO::BIT_DEPTH_F32,
            static_cast<OCIO::OptimizationFlags>(optimizationFlags));
    }

    const int handle = g_nextProcessorHandle++;
    g_processors.emplace(handle, record);
    return handle;
}

OCIO::TransformDirection parseDirection(int direction)
{
    return direction == 1 ? OCIO::TRANSFORM_DIR_INVERSE : OCIO::TRANSFORM_DIR_FORWARD;
}

float clamp01(float value)
{
    if (!std::isfinite(value))
    {
        return 0.0f;
    }
    return std::min(1.0f, std::max(0.0f, value));
}

std::uint8_t floatToByte(float value)
{
    return static_cast<std::uint8_t>(std::lround(clamp01(value) * 255.0f));
}

#define OCIO_BRIDGE_TRY try { clearError();
#define OCIO_BRIDGE_CATCH(value) \
    } catch (const OCIO::Exception & exception) { setError(exception.what()); return value; } \
      catch (const std::exception & exception) { setError(exception.what()); return value; } \
      catch (...) { setError("Unknown C++ exception"); return value; }
}

extern "C"
{

const char * ocio_get_version()
{
    OCIO_BRIDGE_TRY
    return result(OCIO::GetVersion());
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_get_version_hex()
{
    OCIO_BRIDGE_TRY
    return OCIO::GetVersionHex();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_get_last_error()
{
    return g_lastError.c_str();
}

void ocio_clear_all_caches()
{
    OCIO::ClearAllCaches();
}

int ocio_builtin_config_get_count()
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(OCIO::BuiltinConfigRegistry::Get().getNumBuiltinConfigs());
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_builtin_config_get_name(int index)
{
    OCIO_BRIDGE_TRY
    return result(OCIO::BuiltinConfigRegistry::Get().getBuiltinConfigName(static_cast<size_t>(index)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_builtin_config_get_ui_name(int index)
{
    OCIO_BRIDGE_TRY
    return result(OCIO::BuiltinConfigRegistry::Get().getBuiltinConfigUIName(static_cast<size_t>(index)));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_builtin_config_is_recommended(int index)
{
    OCIO_BRIDGE_TRY
    return OCIO::BuiltinConfigRegistry::Get().isBuiltinConfigRecommended(static_cast<size_t>(index)) ? 1 : 0;
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_builtin_config_get_yaml(const char * name)
{
    OCIO_BRIDGE_TRY
    return result(OCIO::BuiltinConfigRegistry::Get().getBuiltinConfigByName(name));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_create_builtin(const char * name)
{
    OCIO_BRIDGE_TRY
    OCIO::ConstConfigRcPtr config = OCIO::Config::CreateFromBuiltinConfig(name);
    config->validate();
    return storeConfig(config);
    OCIO_BRIDGE_CATCH(0)
}

int ocio_config_create_from_file(const char * path)
{
    OCIO_BRIDGE_TRY
    OCIO::ConstConfigRcPtr config = OCIO::Config::CreateFromFile(path);
    config->validate();
    return storeConfig(config);
    OCIO_BRIDGE_CATCH(0)
}

int ocio_config_create_from_string(const char * text, const char * workingDir)
{
    OCIO_BRIDGE_TRY
    std::istringstream stream(text ? text : "");
    OCIO::ConstConfigRcPtr config = OCIO::Config::CreateFromStream(stream);
    if (workingDir && workingDir[0])
    {
        OCIO::ConfigRcPtr editableConfig = config->createEditableCopy();
        editableConfig->setWorkingDir(workingDir);
        config = editableConfig;
    }
    config->validate();
    return storeConfig(config);
    OCIO_BRIDGE_CATCH(0)
}

void ocio_config_release(int handle)
{
    g_configs.erase(handle);
}

int ocio_config_validate(int handle)
{
    OCIO_BRIDGE_TRY
    requireConfig(handle)->validate();
    return 1;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_config_get_major_version(int handle)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(requireConfig(handle)->getMajorVersion());
    OCIO_BRIDGE_CATCH(0)
}

int ocio_config_get_minor_version(int handle)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(requireConfig(handle)->getMinorVersion());
    OCIO_BRIDGE_CATCH(0)
}

int ocio_config_get_num_roles(int handle)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumRoles();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_role_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getRoleName(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_role_color_space(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getRoleColorSpace(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_color_spaces(int handle)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumColorSpaces();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_color_space_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getColorSpaceNameByIndex(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_canonical_name(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getCanonicalName(name));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_color_space_family(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return result(requireColorSpace(requireConfig(handle), name)->getFamily());
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_color_space_encoding(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return result(requireColorSpace(requireConfig(handle), name)->getEncoding());
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_color_space_description(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return result(requireColorSpace(requireConfig(handle), name)->getDescription());
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_color_space_is_data(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return requireColorSpace(requireConfig(handle), name)->isData() ? 1 : 0;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_config_get_color_space_reference_space(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(requireColorSpace(requireConfig(handle), name)->getReferenceSpaceType());
    OCIO_BRIDGE_CATCH(-1)
}

int ocio_config_get_num_color_space_aliases(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(requireColorSpace(requireConfig(handle), name)->getNumAliases());
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_color_space_alias(int handle, const char * name, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireColorSpace(requireConfig(handle), name)->getAlias(static_cast<size_t>(index)));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_color_space_categories(int handle, const char * name)
{
    OCIO_BRIDGE_TRY
    return requireColorSpace(requireConfig(handle), name)->getNumCategories();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_color_space_category(int handle, const char * name, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireColorSpace(requireConfig(handle), name)->getCategory(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_displays(int handle)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumDisplays();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_display(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDisplay(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_default_display(int handle)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDefaultDisplay());
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_views(int handle, const char * display)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumViews(display);
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_view(int handle, const char * display, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getView(display, index));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_default_view(int handle, const char * display)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDefaultView(display));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_default_view_for_color_space(int handle, const char * display, const char * colorSpace)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDefaultView(display, colorSpace));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_view_transform_name(int handle, const char * display, const char * view)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDisplayViewTransformName(display, view));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_view_color_space_name(int handle, const char * display, const char * view)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDisplayViewColorSpaceName(display, view));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_view_looks(int handle, const char * display, const char * view)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDisplayViewLooks(display, view));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_view_description(int handle, const char * display, const char * view)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getDisplayViewDescription(display, view));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_looks(int handle)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumLooks();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_look_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getLookNameByIndex(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_view_transforms(int handle)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumViewTransforms();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_view_transform_name_by_index(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getViewTransformNameByIndex(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_num_named_transforms(int handle)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->getNumNamedTransforms();
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_named_transform_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getNamedTransformNameByIndex(index));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_create_color_space(int configHandle, const char * source, const char * destination, int optimizationFlags)
{
    OCIO_BRIDGE_TRY
    OCIO::ConstProcessorRcPtr processor = requireConfig(configHandle)->getProcessor(source, destination);
    return storeProcessor(processor, optimizationFlags);
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_create_display_view(
    int configHandle,
    const char * source,
    const char * display,
    const char * view,
    int direction,
    int optimizationFlags)
{
    OCIO_BRIDGE_TRY
    OCIO::ConstProcessorRcPtr processor = requireConfig(configHandle)->getProcessor(
        source,
        display,
        view,
        parseDirection(direction));
    return storeProcessor(processor, optimizationFlags);
    OCIO_BRIDGE_CATCH(0)
}

void ocio_processor_release(int handle)
{
    g_processors.erase(handle);
}

const char * ocio_processor_get_cache_id(int handle)
{
    OCIO_BRIDGE_TRY
    return result(requireProcessor(handle).cpuProcessor->getCacheID());
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_is_noop(int handle)
{
    OCIO_BRIDGE_TRY
    return requireProcessor(handle).cpuProcessor->isNoOp() ? 1 : 0;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_is_identity(int handle)
{
    OCIO_BRIDGE_TRY
    return requireProcessor(handle).cpuProcessor->isIdentity() ? 1 : 0;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_apply_rgb_f32(int handle, float * rgb, int pixelCount)
{
    OCIO_BRIDGE_TRY
    if (!rgb || pixelCount < 0)
    {
        throw std::runtime_error("Invalid RGB float buffer");
    }
    OCIO::PackedImageDesc image(rgb, pixelCount, 1, 3);
    requireProcessor(handle).cpuProcessor->apply(image);
    return 1;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_apply_rgba_f32(int handle, float * rgba, int pixelCount)
{
    OCIO_BRIDGE_TRY
    if (!rgba || pixelCount < 0)
    {
        throw std::runtime_error("Invalid RGBA float buffer");
    }
    OCIO::PackedImageDesc image(rgba, pixelCount, 1, 4);
    requireProcessor(handle).cpuProcessor->apply(image);
    return 1;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_apply_rgba_u8(int handle, std::uint8_t * rgba, int pixelCount)
{
    OCIO_BRIDGE_TRY
    if (!rgba || pixelCount < 0)
    {
        throw std::runtime_error("Invalid RGBA Uint8 buffer");
    }

    std::vector<float> floatPixels(static_cast<size_t>(pixelCount) * 4);
    for (int index = 0; index < pixelCount; ++index)
    {
        const int offset = index * 4;
        floatPixels[static_cast<size_t>(offset)] = static_cast<float>(rgba[offset]) / 255.0f;
        floatPixels[static_cast<size_t>(offset + 1)] = static_cast<float>(rgba[offset + 1]) / 255.0f;
        floatPixels[static_cast<size_t>(offset + 2)] = static_cast<float>(rgba[offset + 2]) / 255.0f;
        floatPixels[static_cast<size_t>(offset + 3)] = static_cast<float>(rgba[offset + 3]) / 255.0f;
    }

    OCIO::PackedImageDesc image(floatPixels.data(), pixelCount, 1, 4);
    requireProcessor(handle).cpuProcessor->apply(image);

    for (int index = 0; index < pixelCount; ++index)
    {
        const int offset = index * 4;
        rgba[offset] = floatToByte(floatPixels[static_cast<size_t>(offset)]);
        rgba[offset + 1] = floatToByte(floatPixels[static_cast<size_t>(offset + 1)]);
        rgba[offset + 2] = floatToByte(floatPixels[static_cast<size_t>(offset + 2)]);
        rgba[offset + 3] = floatToByte(floatPixels[static_cast<size_t>(offset + 3)]);
    }

    return 1;
    OCIO_BRIDGE_CATCH(0)
}

}
