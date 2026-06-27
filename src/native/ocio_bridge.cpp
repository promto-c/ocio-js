#include <OpenColorIO/OpenColorIO.h>

#include <algorithm>
#include <cctype>
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
    OCIO::ConstGPUProcessorRcPtr gpuProcessor;
    OCIO::GpuShaderDescRcPtr gpuShaderDesc;
    int optimizationFlags = std::numeric_limits<int>::min();
    std::string gpuShaderLanguage;
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
    record.optimizationFlags = optimizationFlags;

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

std::string normalizeGpuLanguage(const char * language)
{
    std::string value = language ? language : "";
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
        return static_cast<char>(std::tolower(character));
    });
    std::replace(value.begin(), value.end(), '-', '_');

    if (value.empty() || value == "glsl" || value == "webgl2")
    {
        return "glsl_es_3.0";
    }
    if (value == "webgl" || value == "webgl1")
    {
        return "glsl_es_1.0";
    }
    return value;
}

OCIO::ConstGPUProcessorRcPtr requireGPUProcessor(ProcessorRecord & record)
{
    if (!record.gpuProcessor)
    {
        if (record.optimizationFlags == std::numeric_limits<int>::min())
        {
            record.gpuProcessor = record.processor->getDefaultGPUProcessor();
        }
        else
        {
            record.gpuProcessor = record.processor->getOptimizedGPUProcessor(
                static_cast<OCIO::OptimizationFlags>(record.optimizationFlags));
        }
    }
    return record.gpuProcessor;
}

OCIO::GpuShaderDescRcPtr requireGpuShaderDesc(int handle)
{
    ProcessorRecord & record = requireProcessor(handle);
    if (!record.gpuShaderDesc)
    {
        std::ostringstream stream;
        stream << "No OCIO GPU shader info has been extracted for processor handle: " << handle;
        throw std::runtime_error(stream.str());
    }
    return record.gpuShaderDesc;
}

struct GpuTextureInfo
{
    const float * values = nullptr;
    const char * textureName = nullptr;
    const char * samplerName = nullptr;
    unsigned width = 0;
    unsigned height = 0;
    unsigned depth = 1;
    int channels = 0;
    int dimensions = 0;
    OCIO::Interpolation interpolation = OCIO::INTERP_UNKNOWN;
};

GpuTextureInfo getGpuTextureInfo(const OCIO::GpuShaderDescRcPtr & shaderDesc, int index)
{
    if (index < 0)
    {
        throw std::runtime_error("Invalid OCIO GPU texture index");
    }

    const unsigned textureIndex = static_cast<unsigned>(index);
    const unsigned texture3DCount = shaderDesc->getNum3DTextures();

    GpuTextureInfo info;
    if (textureIndex < texture3DCount)
    {
        unsigned edgeLength = 0;
        shaderDesc->get3DTexture(textureIndex, info.textureName, info.samplerName, edgeLength, info.interpolation);
        shaderDesc->get3DTextureValues(textureIndex, info.values);
        info.width = edgeLength;
        info.height = edgeLength;
        info.depth = edgeLength;
        info.channels = 3;
        info.dimensions = 3;
        return info;
    }

    const unsigned texture2DIndex = textureIndex - texture3DCount;
    const unsigned texture2DCount = shaderDesc->getNumTextures();
    if (texture2DIndex >= texture2DCount)
    {
        std::ostringstream stream;
        stream << "OCIO GPU texture index out of range: " << index;
        throw std::runtime_error(stream.str());
    }

    OCIO::GpuShaderDesc::TextureType channel = OCIO::GpuShaderDesc::TEXTURE_RGB_CHANNEL;
    OCIO::GpuShaderDesc::TextureDimensions dimensions = OCIO::GpuShaderDesc::TEXTURE_1D;
    shaderDesc->getTexture(
        texture2DIndex,
        info.textureName,
        info.samplerName,
        info.width,
        info.height,
        channel,
        dimensions,
        info.interpolation);
    shaderDesc->getTextureValues(texture2DIndex, info.values);
    info.depth = 1;
    info.channels = channel == OCIO::GpuShaderDesc::TEXTURE_RGB_CHANNEL ? 3 : 1;
    info.dimensions = static_cast<int>(dimensions);
    return info;
}

int checkedIntCount(size_t count, const char * label)
{
    if (count > static_cast<size_t>(std::numeric_limits<int>::max()))
    {
        std::ostringstream stream;
        stream << label << " is too large to expose through ocio-js";
        throw std::runtime_error(stream.str());
    }
    return static_cast<int>(count);
}

OCIO::GpuShaderDesc::UniformData getGpuUniformData(
    const OCIO::GpuShaderDescRcPtr & shaderDesc,
    int index,
    const char ** name = nullptr)
{
    if (index < 0)
    {
        throw std::runtime_error("Invalid OCIO GPU uniform index");
    }

    OCIO::GpuShaderDesc::UniformData data;
    const char * uniformName = shaderDesc->getUniform(static_cast<unsigned>(index), data);
    if (name)
    {
        *name = uniformName;
    }
    return data;
}

int getGpuUniformValueCount(const OCIO::GpuShaderDesc::UniformData & data)
{
    switch (data.m_type)
    {
        case OCIO::UNIFORM_DOUBLE:
        case OCIO::UNIFORM_BOOL:
            return 1;
        case OCIO::UNIFORM_FLOAT3:
            return 3;
        case OCIO::UNIFORM_VECTOR_FLOAT:
            return data.m_vectorFloat.m_getSize ? data.m_vectorFloat.m_getSize() : 0;
        case OCIO::UNIFORM_VECTOR_INT:
            return data.m_vectorInt.m_getSize ? data.m_vectorInt.m_getSize() : 0;
        case OCIO::UNIFORM_UNKNOWN:
        default:
            return 0;
    }
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

int ocio_config_get_num_file_rules(int handle)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(requireConfig(handle)->getFileRules()->getNumEntries());
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_file_rule_name(int handle, int ruleIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getName(static_cast<size_t>(ruleIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_file_rule_color_space(int handle, int ruleIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getColorSpace(static_cast<size_t>(ruleIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_file_rule_pattern(int handle, int ruleIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getPattern(static_cast<size_t>(ruleIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_file_rule_extension(int handle, int ruleIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getExtension(static_cast<size_t>(ruleIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_file_rule_regex(int handle, int ruleIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getRegex(static_cast<size_t>(ruleIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_file_rule_custom_key_count(int handle, int ruleIndex)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(
        requireConfig(handle)->getFileRules()->getNumCustomKeys(static_cast<size_t>(ruleIndex)));
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_config_get_file_rule_custom_key_name(int handle, int ruleIndex, int keyIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getCustomKeyName(
        static_cast<size_t>(ruleIndex),
        static_cast<size_t>(keyIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_file_rule_custom_key_value(int handle, int ruleIndex, int keyIndex)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getFileRules()->getCustomKeyValue(
        static_cast<size_t>(ruleIndex),
        static_cast<size_t>(keyIndex)));
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_config_get_color_space_from_filepath(int handle, const char * filePath)
{
    OCIO_BRIDGE_TRY
    return result(requireConfig(handle)->getColorSpaceFromFilepath(filePath));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_config_get_file_rule_index_from_filepath(int handle, const char * filePath)
{
    OCIO_BRIDGE_TRY
    size_t ruleIndex = 0;
    requireConfig(handle)->getColorSpaceFromFilepath(filePath, ruleIndex);
    if (ruleIndex > static_cast<size_t>(std::numeric_limits<int>::max()))
    {
        throw std::runtime_error("OCIO file rule index exceeds the supported range");
    }
    return static_cast<int>(ruleIndex);
    OCIO_BRIDGE_CATCH(-1)
}

int ocio_config_filepath_only_matches_default_rule(int handle, const char * filePath)
{
    OCIO_BRIDGE_TRY
    return requireConfig(handle)->filepathOnlyMatchesDefaultRule(filePath) ? 1 : 0;
    OCIO_BRIDGE_CATCH(0)
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

int ocio_processor_extract_gpu_shader_info(
    int handle,
    const char * language,
    const char * functionName,
    const char * resourcePrefix,
    int textureMaxWidth,
    int allowTexture1D)
{
    OCIO_BRIDGE_TRY
    ProcessorRecord & record = requireProcessor(handle);
    OCIO::GpuShaderDescRcPtr shaderDesc = OCIO::GpuShaderDesc::CreateShaderDesc();
    const OCIO::GpuLanguage gpuLanguage = OCIO::GpuLanguageFromString(normalizeGpuLanguage(language).c_str());
    shaderDesc->setLanguage(gpuLanguage);
    shaderDesc->setFunctionName((functionName && functionName[0]) ? functionName : "OCIODisplay");
    shaderDesc->setResourcePrefix((resourcePrefix && resourcePrefix[0]) ? resourcePrefix : "ocio");
    shaderDesc->setAllowTexture1D(allowTexture1D != 0);
    if (textureMaxWidth > 0)
    {
        shaderDesc->setTextureMaxWidth(static_cast<unsigned>(textureMaxWidth));
    }

    OCIO::ConstGPUProcessorRcPtr gpuProcessor = requireGPUProcessor(record);
    gpuProcessor->extractGpuShaderInfo(shaderDesc);

    record.gpuShaderDesc = shaderDesc;
    record.gpuShaderLanguage = OCIO::GpuLanguageToString(gpuLanguage);
    return 1;
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_processor_get_gpu_shader_text(int handle)
{
    OCIO_BRIDGE_TRY
    return result(requireGpuShaderDesc(handle)->getShaderText());
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_processor_get_gpu_shader_language(int handle)
{
    OCIO_BRIDGE_TRY
    ProcessorRecord & record = requireProcessor(handle);
    requireGpuShaderDesc(handle);
    return result(record.gpuShaderLanguage);
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_processor_get_gpu_shader_function_name(int handle)
{
    OCIO_BRIDGE_TRY
    return result(requireGpuShaderDesc(handle)->getFunctionName());
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_processor_get_gpu_shader_cache_id(int handle)
{
    OCIO_BRIDGE_TRY
    return result(requireGpuShaderDesc(handle)->getCacheID());
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_get_gpu_shader_uniform_buffer_size(int handle)
{
    OCIO_BRIDGE_TRY
    return checkedIntCount(requireGpuShaderDesc(handle)->getUniformBufferSize(), "OCIO GPU uniform buffer");
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_get_gpu_shader_texture_count(int handle)
{
    OCIO_BRIDGE_TRY
    OCIO::GpuShaderDescRcPtr shaderDesc = requireGpuShaderDesc(handle);
    return checkedIntCount(
        static_cast<size_t>(shaderDesc->getNum3DTextures()) + static_cast<size_t>(shaderDesc->getNumTextures()),
        "OCIO GPU texture count");
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_processor_get_gpu_shader_texture_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(getGpuTextureInfo(requireGpuShaderDesc(handle), index).textureName);
    OCIO_BRIDGE_CATCH(nullptr)
}

const char * ocio_processor_get_gpu_shader_texture_sampler_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(getGpuTextureInfo(requireGpuShaderDesc(handle), index).samplerName);
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_get_gpu_shader_texture_width(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return checkedIntCount(getGpuTextureInfo(requireGpuShaderDesc(handle), index).width, "OCIO GPU texture width");
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_get_gpu_shader_texture_height(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return checkedIntCount(getGpuTextureInfo(requireGpuShaderDesc(handle), index).height, "OCIO GPU texture height");
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_get_gpu_shader_texture_depth(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return checkedIntCount(getGpuTextureInfo(requireGpuShaderDesc(handle), index).depth, "OCIO GPU texture depth");
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_get_gpu_shader_texture_dimensions(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return getGpuTextureInfo(requireGpuShaderDesc(handle), index).dimensions;
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_get_gpu_shader_texture_channels(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return getGpuTextureInfo(requireGpuShaderDesc(handle), index).channels;
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_processor_get_gpu_shader_texture_interpolation(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return result(OCIO::InterpolationToString(getGpuTextureInfo(requireGpuShaderDesc(handle), index).interpolation));
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_get_gpu_shader_texture_value_count(int handle, int index)
{
    OCIO_BRIDGE_TRY
    const GpuTextureInfo info = getGpuTextureInfo(requireGpuShaderDesc(handle), index);
    const size_t valueCount = static_cast<size_t>(info.width)
        * static_cast<size_t>(info.height)
        * static_cast<size_t>(info.depth)
        * static_cast<size_t>(info.channels);
    return checkedIntCount(valueCount, "OCIO GPU texture value count");
    OCIO_BRIDGE_CATCH(0)
}

const float * ocio_processor_get_gpu_shader_texture_values(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return getGpuTextureInfo(requireGpuShaderDesc(handle), index).values;
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_get_gpu_shader_uniform_count(int handle)
{
    OCIO_BRIDGE_TRY
    return checkedIntCount(requireGpuShaderDesc(handle)->getNumUniforms(), "OCIO GPU uniform count");
    OCIO_BRIDGE_CATCH(0)
}

const char * ocio_processor_get_gpu_shader_uniform_name(int handle, int index)
{
    OCIO_BRIDGE_TRY
    const char * name = nullptr;
    getGpuUniformData(requireGpuShaderDesc(handle), index, &name);
    return result(name);
    OCIO_BRIDGE_CATCH(nullptr)
}

int ocio_processor_get_gpu_shader_uniform_type(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return static_cast<int>(getGpuUniformData(requireGpuShaderDesc(handle), index).m_type);
    OCIO_BRIDGE_CATCH(static_cast<int>(OCIO::UNIFORM_UNKNOWN))
}

int ocio_processor_get_gpu_shader_uniform_buffer_offset(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return checkedIntCount(
        getGpuUniformData(requireGpuShaderDesc(handle), index).m_bufferOffset,
        "OCIO GPU uniform buffer offset");
    OCIO_BRIDGE_CATCH(0)
}

int ocio_processor_get_gpu_shader_uniform_value_count(int handle, int index)
{
    OCIO_BRIDGE_TRY
    return getGpuUniformValueCount(getGpuUniformData(requireGpuShaderDesc(handle), index));
    OCIO_BRIDGE_CATCH(0)
}

double ocio_processor_get_gpu_shader_uniform_value_f64(int handle, int index, int valueIndex)
{
    OCIO_BRIDGE_TRY
    if (valueIndex < 0)
    {
        throw std::runtime_error("Invalid OCIO GPU uniform value index");
    }
    const OCIO::GpuShaderDesc::UniformData data = getGpuUniformData(requireGpuShaderDesc(handle), index);
    const int count = getGpuUniformValueCount(data);
    if (valueIndex >= count)
    {
        throw std::runtime_error("OCIO GPU uniform value index out of range");
    }

    switch (data.m_type)
    {
        case OCIO::UNIFORM_DOUBLE:
            return data.m_getDouble ? data.m_getDouble() : 0.0;
        case OCIO::UNIFORM_BOOL:
            return (data.m_getBool && data.m_getBool()) ? 1.0 : 0.0;
        case OCIO::UNIFORM_FLOAT3:
            return data.m_getFloat3 ? static_cast<double>(data.m_getFloat3()[valueIndex]) : 0.0;
        case OCIO::UNIFORM_VECTOR_FLOAT:
            return data.m_vectorFloat.m_getVector
                ? static_cast<double>(data.m_vectorFloat.m_getVector()[valueIndex])
                : 0.0;
        case OCIO::UNIFORM_VECTOR_INT:
            return data.m_vectorInt.m_getVector
                ? static_cast<double>(data.m_vectorInt.m_getVector()[valueIndex])
                : 0.0;
        case OCIO::UNIFORM_UNKNOWN:
        default:
            return 0.0;
    }
    OCIO_BRIDGE_CATCH(0.0)
}

int ocio_processor_get_gpu_shader_uniform_value_i32(int handle, int index, int valueIndex)
{
    OCIO_BRIDGE_TRY
    if (valueIndex < 0)
    {
        throw std::runtime_error("Invalid OCIO GPU uniform value index");
    }
    const OCIO::GpuShaderDesc::UniformData data = getGpuUniformData(requireGpuShaderDesc(handle), index);
    const int count = getGpuUniformValueCount(data);
    if (valueIndex >= count)
    {
        throw std::runtime_error("OCIO GPU uniform value index out of range");
    }

    switch (data.m_type)
    {
        case OCIO::UNIFORM_BOOL:
            return (data.m_getBool && data.m_getBool()) ? 1 : 0;
        case OCIO::UNIFORM_VECTOR_INT:
            return data.m_vectorInt.m_getVector ? data.m_vectorInt.m_getVector()[valueIndex] : 0;
        case OCIO::UNIFORM_DOUBLE:
        case OCIO::UNIFORM_FLOAT3:
        case OCIO::UNIFORM_VECTOR_FLOAT:
        case OCIO::UNIFORM_UNKNOWN:
        default:
            return static_cast<int>(ocio_processor_get_gpu_shader_uniform_value_f64(handle, index, valueIndex));
    }
    OCIO_BRIDGE_CATCH(0)
}

}
