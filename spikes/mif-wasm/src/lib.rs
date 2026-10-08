//! Thin wasm-bindgen surface over mif-rs, mirroring src/engine in the plugin.
//! Everything crosses the boundary as JSON text to keep bindings trivial.

use wasm_bindgen::prelude::*;

fn json(value: &serde_json::Value) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| JsError::new(&e.to_string()))
}

/// `{"frontmatter": {...}, "body": "..."}`
#[wasm_bindgen(js_name = parseMarkdown)]
pub fn parse_markdown(md: &str) -> Result<String, JsError> {
    let (frontmatter, body) = mif_frontmatter::parse_markdown(md).map_err(|e| JsError::new(&e.to_string()))?;
    let fm = serde_json::to_value(&frontmatter).map_err(|e| JsError::new(&e.to_string()))?;
    json(&serde_json::json!({ "frontmatter": fm, "body": body }))
}

/// The derived JSON-LD document.
#[wasm_bindgen(js_name = toJsonLd)]
pub fn to_jsonld(md: &str) -> Result<String, JsError> {
    let (frontmatter, body) = mif_frontmatter::parse_markdown(md).map_err(|e| JsError::new(&e.to_string()))?;
    let jsonld = mif_frontmatter::md_to_jsonld(&frontmatter, &body).map_err(|e| JsError::new(&e.to_string()))?;
    json(&jsonld)
}

/// `null` when md -> json-ld -> md is lossless, otherwise the drift message.
#[wasm_bindgen(js_name = roundtripDrift)]
pub fn roundtrip_drift(md: &str) -> Option<String> {
    mif_frontmatter::roundtrip_lossless(md).err().map(|e| e.to_string())
}

#[cfg(feature = "schema")]
/// Schema messages for a JSON-LD document (empty when valid).
#[wasm_bindgen(js_name = validateJsonLd)]
pub fn validate_jsonld(jsonld: &str) -> Result<Vec<String>, JsError> {
    let value: serde_json::Value = serde_json::from_str(jsonld).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(match mif_schema::validate_document(&value) {
        Ok(()) => Vec::new(),
        Err(e) => {
            let messages = e.messages().to_vec();
            if messages.is_empty() { vec![e.to_string()] } else { messages }
        }
    })
}

#[cfg(feature = "ontology")]
/// Parse an ontology definition (YAML) and return its id, proving the
/// ontology crate links and runs under WASM.
#[wasm_bindgen(js_name = ontologyId)]
pub fn ontology_id(yaml: &str) -> Result<String, JsError> {
    let meta = mif_ontology::parse_definition(yaml, "inline").map_err(|e| JsError::new(&e.to_string()))?;
    Ok(meta.id)
}

/// Golden helper: resolve an `extends` chain with mif-ontology over a corpus
/// given as a JSON array of ontology YAML texts. Returns the chain's ids
/// (base first) as JSON, or the error message.
#[cfg(feature = "ontology")]
#[wasm_bindgen(js_name = resolveChain)]
pub fn resolve_chain(corpus_yaml: &str, id: &str) -> Result<String, JsError> {
    let texts: Vec<String> = serde_json::from_str(corpus_yaml).map_err(|e| JsError::new(&e.to_string()))?;
    let mut corpus = std::collections::HashMap::new();
    for (i, text) in texts.iter().enumerate() {
        let meta = mif_ontology::parse_definition(text, &format!("corpus[{i}]")).map_err(|e| JsError::new(&e.to_string()))?;
        corpus.insert(meta.id.clone(), meta);
    }
    let chain = mif_ontology::resolve_chain(id, &corpus).map_err(|e| JsError::new(&e.to_string()))?;
    json(&serde_json::json!(chain.iter().map(|m| m.id.clone()).collect::<Vec<_>>()))
}
