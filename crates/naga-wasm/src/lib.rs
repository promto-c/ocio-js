use naga::back::wgsl;
use naga::front::glsl;
use naga::valid::{Capabilities, ValidationFlags, Validator};
use naga::ShaderStage;
use wasm_bindgen::prelude::*;

fn translate_glsl_fragment(source: &str) -> Result<String, String> {
    let mut frontend = glsl::Frontend::default();
    let options = glsl::Options::from(ShaderStage::Fragment);
    let module = frontend
        .parse(&options, source)
        .map_err(|errors| format!("Naga GLSL parse failed: {errors:?}"))?;

    let info = Validator::new(ValidationFlags::all(), Capabilities::all())
        .validate(&module)
        .map_err(|error| format!("Naga validation failed: {error}"))?;

    wgsl::write_string(&module, &info, wgsl::WriterFlags::empty())
        .map_err(|error| format!("Naga WGSL generation failed: {error}"))
}

#[wasm_bindgen]
pub fn glsl_fragment_to_wgsl(source: &str) -> Result<String, JsError> {
    translate_glsl_fragment(source).map_err(|error| JsError::new(&error))
}

#[cfg(test)]
mod tests {
    use super::translate_glsl_fragment;

    #[test]
    fn translates_split_sampler_function_without_entry_point() {
        let source = r#"#version 460
layout(set=0, binding=1) uniform texture2D ocio_lut;
layout(set=0, binding=2) uniform sampler ocio_lutSampler;
vec4 OCIODisplay(vec4 color) {
    return texture(sampler2D(ocio_lut, ocio_lutSampler), color.xy);
}
layout(location=0) out vec4 ocio_naga_out;
void main() { ocio_naga_out = OCIODisplay(vec4(0.0)); }
"#;
        let wgsl = translate_glsl_fragment(source).expect("translation should succeed");
        assert!(wgsl.contains("fn OCIODisplay"));
        assert!(wgsl.contains("@group(0) @binding(1)"));
        assert!(wgsl.contains("@group(0) @binding(2)"));
    }
}
