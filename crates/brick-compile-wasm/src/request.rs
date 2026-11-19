#![forbid(unsafe_code)]

use std::collections::HashMap;

use brick_compile::cover::CoverShard;
use brick_compile::Lod;
use serde::Deserialize;

pub type Range = (usize, usize);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub request: Operation,
    pub segments: HashMap<String, Range>,
    pub library: Option<LibraryDelta>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryDelta {
    pub key: String,
    pub files: Vec<LibraryFile>,
    pub absent: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryFile {
    pub path: String,
    pub bytes: Range,
}

#[derive(Deserialize)]
#[serde(
    tag = "op",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Operation {
    ReadModel,
    ReadStudio,
    Compile {
        lod: LodName,
        stud_primitives: Vec<String>,
        unofficial_allowlist: Vec<String>,
        connectors: ConnectorInputs,
        parts: Vec<String>,
        inline_checks: Vec<InlineCheck>,
    },
    BakeNeeds {
        stud_primitives: Vec<String>,
    },
    Bake {
        stud_primitives: Vec<String>,
        unofficial_allowlist: Vec<String>,
        translucent_colors: Vec<u32>,
        table_depth_ldu: f64,
        shard: Option<Shard>,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ConnectorInputs {
    pub primitives: Option<serde_json::Value>,
    pub section_vocabulary: serde_json::Value,
    pub cavity_probe: String,
    pub infer: Vec<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Shard {
    from: usize,
    to: usize,
    of: usize,
    pub visibility_only: bool,
}

impl Shard {
    pub fn cover(&self) -> Result<CoverShard, String> {
        let Shard { from, to, of, .. } = *self;
        if from > to || to > of || of == 0 {
            return Err(format!(
                "bake shard {from}..{to} of {of} is not a slice of the candidates"
            ));
        }
        Ok(CoverShard { from, to, of })
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LodName {
    Standard,
    Low,
    Far,
}

impl From<LodName> for Lod {
    fn from(name: LodName) -> Self {
        match name {
            LodName::Standard => Lod::Standard,
            LodName::Low => Lod::Low,
            LodName::Far => Lod::Far,
        }
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InlineCheck {
    pub inline: String,
    pub official: String,
}
