#![forbid(unsafe_code)]

use std::collections::HashSet;

use brick_compile::connect::{
    record_json, ConnectorExtractor, InferredFeatures, PartRecords, PrimitiveConnectors,
    PrimitiveTable, SectionVocabulary, ShadowSnaps,
};
use brick_compile::Library;
use serde_json::Value;

use crate::request::ConnectorInputs;

struct NoShadowLibrary;

impl Library for NoShadowLibrary {
    fn source(&self, _path: &str) -> Option<&str> {
        None
    }
}

pub struct ConnectorInference<'r> {
    infer: HashSet<&'r str>,
    primitives: Option<&'r Value>,
    vocabulary: SectionVocabulary,
    cavity_probe: &'r str,
}

impl<'r> ConnectorInference<'r> {
    pub fn new(inputs: &'r ConnectorInputs) -> Result<Self, String> {
        Ok(ConnectorInference {
            infer: inputs.infer.iter().map(String::as_str).collect(),
            primitives: inputs.primitives.as_ref(),
            vocabulary: SectionVocabulary::from_json(&inputs.section_vocabulary)?,
            cavity_probe: &inputs.cavity_probe,
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
    ) -> Result<Value, String> {
        let primitives = self
            .primitives
            .ok_or("inferring connectors needs the primitive table")?;
        let mut extractor = ConnectorExtractor::new(
            ShadowSnaps::new(library, &NoShadowLibrary),
            PrimitiveConnectors::new(library, PrimitiveTable::from_json(primitives)?),
            InferredFeatures::new(library, self.vocabulary.clone(), self.cavity_probe)?,
        );
        let records = PartRecords::of(&extractor.extract(path));
        Ok(record_json(reference, license, &records.connectors))
    }
}
