use crate::workspace::Result;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_IMAGES: usize = 4;
pub const MAX_TOTAL: usize = 4 * 1024 * 1024;
const MAX_FILE: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Image {
    pub name: String,
    pub data_url: String,
}

pub fn parse(value: &Value) -> Result<Vec<Image>> {
    if value.is_null() {
        return Ok(Vec::new());
    }
    let values = value.as_array().ok_or("Images must be an array")?;
    if values.len() > MAX_IMAGES {
        return Err("Attach at most 4 images per message".into());
    }
    let mut total = 0;
    values
        .iter()
        .map(|value| {
            let image: Image = serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
            if image.name.trim().is_empty()
                || image.name.len() > 255
                || image.name.chars().any(char::is_control)
            {
                return Err(
                    "Image filenames must be 1-255 bytes without control characters".into(),
                );
            }
            let (mime, data) = data(&image.data_url)?;
            if data.len() > MAX_FILE.div_ceil(3) * 4 {
                return Err("Each image must be at most 2 MiB".into());
            }
            let bytes = STANDARD.decode(data).map_err(|_| "Invalid image base64")?;
            total += bytes.len();
            if bytes.is_empty() || bytes.len() > MAX_FILE || total > MAX_TOTAL {
                return Err("Images must be nonempty, at most 2 MiB each and 4 MiB total".into());
            }
            let format = image::guess_format(&bytes).map_err(|_| "Invalid image")?;
            if !matches!(
                (mime, format),
                ("image/png", image::ImageFormat::Png) | ("image/jpeg", image::ImageFormat::Jpeg)
            ) {
                return Err("Image content does not match its PNG/JPEG media type".into());
            }
            let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
            let mut limits = image::Limits::default();
            limits.max_image_width = Some(2048);
            limits.max_image_height = Some(2048);
            limits.max_alloc = Some(32 * 1024 * 1024);
            reader.limits(limits);
            reader
                .decode()
                .map_err(|_| "Invalid image or image exceeds 2048 pixels per side")?;
            Ok(image)
        })
        .collect()
}

pub fn data(url: &str) -> Result<(&str, &str)> {
    for mime in ["image/png", "image/jpeg"] {
        if let Some(data) = url.strip_prefix(&format!("data:{mime};base64,")) {
            return Ok((mime, data));
        }
    }
    Err("Only inline PNG/JPEG images are supported".into())
}

pub fn content(text: &str, images: &[Image]) -> Value {
    if images.is_empty() {
        return json!(text);
    }
    let mut parts = Vec::new();
    if !text.is_empty() {
        parts.push(json!({"type":"text","text":text}));
    }
    parts.extend(
        images
            .iter()
            .map(|image| json!({"type":"image_url","image_url":{"url":image.data_url}})),
    );
    json!(parts)
}

// Inline bytes are request size, not text tokens. Reserve a conservative image allowance
// separately, and bound the whole retained request, not just its newest turn.
pub fn cost(message: &Value) -> Result<(usize, usize, usize)> {
    let mut value = message.clone();
    let mut count = 0;
    let mut bytes = 0;
    if message["role"] == "user" {
        if let Some(parts) = value["content"].as_array_mut() {
            for part in parts {
                match part["type"].as_str() {
                    Some("text") if part["text"].is_string() => (),
                    Some("image_url") => {
                        let (_, encoded) = data(
                            part["image_url"]["url"]
                                .as_str()
                                .ok_or("Missing image URL")?,
                        )?;
                        count += 1;
                        bytes += (encoded.len() / 4 * 3)
                            .checked_sub(encoded.bytes().rev().take_while(|b| *b == b'=').count())
                            .ok_or("Invalid saved image base64")?;
                        part["image_url"]["url"] = json!("");
                    }
                    _ => return Err("Unsupported user content part".into()),
                }
            }
        }
    }
    Ok((
        serde_json::to_vec(&value).map_err(|e| e.to_string())?.len() + count * 8192,
        count,
        bytes,
    ))
}

pub fn has_images(messages: &[Value]) -> bool {
    messages.iter().any(|message| {
        message["role"] == "user"
            && message["content"]
                .as_array()
                .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image_url"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn fixture() -> Value {
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2, 2)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        json!({"name":"screen.png","dataUrl":format!("data:image/png;base64,{}", STANDARD.encode(bytes.into_inner()))})
    }

    #[test]
    fn validates_image_bytes_mime_count_size_and_dimensions() {
        let valid = fixture();
        assert_eq!(parse(&json!([valid])).unwrap().len(), 1);
        assert!(parse(&Value::Null).unwrap().is_empty());
        for invalid in [
            json!([{"name":"bad.svg","dataUrl":"data:image/svg+xml;base64,PHN2Zy8+"}]),
            json!([{"name":"bad.png","dataUrl":"data:image/png;base64,invalid"}]),
            json!([{"name":"empty.png","dataUrl":"data:image/png;base64,"}]),
            json!([{"name":"remote.png","dataUrl":"https://example.com/image.png"}]),
            json!([{"name":"bad.png","dataUrl":valid["dataUrl"].as_str().unwrap().replace("image/png", "image/jpeg")}]),
            json!([valid, valid, valid, valid, valid]),
            json!([{"name":"big.png","dataUrl":format!("data:image/png;base64,{}", "A".repeat(MAX_FILE.div_ceil(3) * 4 + 4))}]),
            json!([{"name":"bad\nname.png","dataUrl":valid["dataUrl"]}]),
        ] {
            assert!(parse(&invalid).is_err());
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        image::DynamicImage::new_rgb8(2049, 1)
            .write_to(&mut bytes, image::ImageFormat::Png)
            .unwrap();
        assert!(parse(&json!([{"name":"wide.png","dataUrl":format!("data:image/png;base64,{}", STANDARD.encode(bytes.into_inner()))}])).is_err());
        let mut truncated = STANDARD
            .decode(data(valid["dataUrl"].as_str().unwrap()).unwrap().1)
            .unwrap();
        truncated.truncate(32);
        assert!(parse(&json!([{"name":"truncated.png","dataUrl":format!("data:image/png;base64,{}", STANDARD.encode(truncated))}])).is_err());
    }
}
