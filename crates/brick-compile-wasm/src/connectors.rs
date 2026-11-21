#![forbid(unsafe_code)]

use std::collections::HashSet;

use brick_compile::connect::{
    record_json, verified_patch_paths, ConnectorExtractor, InferredFeatures, PartRecords,
    PrimitiveConnectors, PrimitiveTable, SectionVocabulary, ShadowPatches, ShadowSnaps, TierRecord,
    CONNECTIVITY_LICENSE,
};
use brick_compile::Library;
use serde_json::Value;

use crate::reply::InferredRecords;
use crate::request::ConnectorInputs;

const SHADOW_NAMESPACE: &str = "shadow:";
const SHADOW_PATCH_NAMESPACE: &str = "shadow-patch:";

struct Namespaced<'l, L: Library> {
    library: &'l L,
    namespace: &'static str,
}

impl<L: Library> Library for Namespaced<'_, L> {
    fn source(&self, path: &str) -> Option<&str> {
        self.library.source(&format!("{}{path}", self.namespace))
    }
}

pub struct ConnectorInference<'r> {
    infer: HashSet<&'r str>,
    primitives: Option<&'r Value>,
    vocabulary: SectionVocabulary,
    cavity_probe: &'r str,
    verified_patches: Option<HashSet<String>>,
}

fn published(part: &str, license: &str, record: &TierRecord) -> Option<Value> {
    (!record.is_empty()).then(|| record_json(part, license, record))
}

impl<'r> ConnectorInference<'r> {
    pub fn new(inputs: &'r ConnectorInputs) -> Result<Self, String> {
        Ok(ConnectorInference {
            infer: inputs.infer.iter().map(String::as_str).collect(),
            primitives: inputs.primitives.as_ref(),
            vocabulary: SectionVocabulary::from_json(&inputs.section_vocabulary)?,
            cavity_probe: &inputs.cavity_probe,
            verified_patches: inputs
                .shadow_patch_manifest
                .as_ref()
                .map(verified_patch_paths),
        })
    }

    pub fn wants(&self, reference: &str) -> bool {
        self.infer.contains(reference)
    }

    pub fn record<L: Library>(
        &self,
        library: &L,
        reference: &str,
        path: &str,
        license: &str,
    ) -> Result<InferredRecords, String> {
        let primitives = self
            .primitives
            .ok_or("inferring connectors needs the primitive table")?;
        let verified = self
            .verified_patches
            .as_ref()
            .ok_or("inferring connectors needs the shadow patch manifest")?;
        let shadow = Namespaced {
            library,
            namespace: SHADOW_NAMESPACE,
        };
        let patches = Namespaced {
            library,
            namespace: SHADOW_PATCH_NAMESPACE,
        };
        let mut extractor = ConnectorExtractor::new(
            ShadowSnaps::new(library, &shadow).patched(ShadowPatches {
                files: &patches,
                verified,
            }),
            PrimitiveConnectors::new(library, PrimitiveTable::from_json(primitives)?),
            InferredFeatures::new(library, self.vocabulary.clone(), self.cavity_probe)?,
        );
        let records = PartRecords::of(&extractor.extract(path));
        Ok(InferredRecords {
            connectivity: published(reference, CONNECTIVITY_LICENSE, &records.connectivity),
            connectors: published(reference, license, &records.connectors),
        })
    }
}
