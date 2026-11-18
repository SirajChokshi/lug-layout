#![forbid(unsafe_code)]

use std::collections::HashMap;

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
        parts: Vec<String>,
        inline_checks: Vec<InlineCheck>,
    },
    Bake {
        stud_primitives: Vec<String>,
        unofficial_allowlist: Vec<String>,
        translucent_colors: Vec<u32>,
        vehicles: Option<VehicleInputs>,
    },
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
    inner: f64,
    outer: f64,
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

    pub fn rails(&self) -> Vec<RailHeadBand> {
        self.rail_heads
            .iter()
            .map(|rail| RailHeadBand {
                rail_part: rail.rail_part.clone(),
                inner: rail.inner,
                outer: rail.outer,
            })
            .collect()
    }
}
