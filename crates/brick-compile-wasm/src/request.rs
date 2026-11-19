#![forbid(unsafe_code)]

use std::collections::HashMap;

use brick_compile::cover::CoverShard;
use brick_compile::vehicle::{RailHeadBand, VehicleSignatures};
use brick_compile::Lod;
use serde::Deserialize;

pub type Range = (usize, usize);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub request: Operation,
    pub segments: HashMap<String, Range>,
    pub library: Option<LibraryDelta>,
    pub records: Option<RecordDelta>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordDelta {
    pub key: String,
    pub files: Vec<RecordFile>,
    pub references: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RecordFile {
    pub reference: String,
    pub bytes: Range,
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
        #[serde(default)]
        records: bool,
    },
    BakeNeeds {
        stud_primitives: Vec<String>,
        #[serde(default)]
        vehicles: Option<VehicleInputs>,
    },
    Bake {
        stud_primitives: Vec<String>,
        unofficial_allowlist: Vec<String>,
        translucent_colors: Vec<u32>,
        table_depth_ldu: f64,
        vehicles: Option<VehicleInputs>,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct VehicleInputs {
    parts: VehicleParts,
    rail_heads: Vec<RailHead>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct VehicleParts {
    bogie_pivots: Vec<String>,
    pivot_pins: Vec<String>,
    wheelsets: Vec<String>,
    wheels: Vec<String>,
    couplers: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RailHead {
    rail_part: String,
    inner: String,
    outer: String,
}

impl VehicleInputs {
    pub fn signatures(&self) -> VehicleSignatures {
        VehicleSignatures {
            bogie_pivots: self.parts.bogie_pivots.clone(),
            pivot_pins: self.parts.pivot_pins.clone(),
            wheelsets: self.parts.wheelsets.clone(),
            wheels: self.parts.wheels.clone(),
            couplers: self.parts.couplers.clone(),
        }
    }

    pub fn rails(&self) -> Result<Vec<RailHeadBand>, String> {
        self.rail_heads
            .iter()
            .map(|rail| RailHeadBand::from_decimals(&rail.rail_part, &rail.inner, &rail.outer))
            .collect()
    }
}
