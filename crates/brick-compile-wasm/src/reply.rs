#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use brick_compile::affine::Vec3;
use brick_compile::cover::ModelCover;
use brick_compile::flatten::FlattenError;
use brick_compile::inline::InlineComparison;
use brick_compile::lattice::ModelLattice;
use brick_compile::ldraw::Header;
use brick_compile::studio::{StudioArchive, StudioError};
use brick_compile::vehicle::{Coupler, GuideKind, Vehicle};
use brick_compile::CompileError;
use serde::Serialize;

use crate::request::Range;

pub type Blobs = BTreeMap<&'static str, Range>;

#[derive(Serialize)]
#[serde(tag = "status", rename_all_fields = "camelCase")]
pub enum Reply {
    #[serde(rename = "read")]
    ModelRead {
        sections: Vec<Section>,
        parts: Vec<String>,
        inline_parts: Vec<InlinePair>,
        loose_geometry: Vec<LooseGeometry>,
        instances: usize,
        blobs: Blobs,
    },
    #[serde(rename = "read")]
    StudioRead {
        entry: String,
        ldraw: String,
        studio_version: Option<String>,
        converted_lines: usize,
        unconverted_lines: Vec<usize>,
        bricklink_ids: BTreeMap<String, String>,
        custom_parts: Vec<String>,
    },
    #[serde(rename = "rejected")]
    StudioRejected { kind: &'static str, message: String },
    #[serde(rename = "compiled")]
    Compiled {
        parts: Vec<PartOutcome>,
        inline: Vec<InlineOutcome>,
        weld_epsilon_ldu: f64,
    },
    #[serde(rename = "need")]
    Need { paths: Vec<String> },
    #[serde(rename = "baked")]
    Baked {
        instances: usize,
        lattice: Option<Lattice>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lattice_issue: Option<String>,
        cover: Cover,
        #[serde(skip_serializing_if = "Option::is_none")]
        vehicles: Option<Vec<VehicleHeader>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        vehicle_issue: Option<String>,
        blobs: Blobs,
    },
    #[serde(rename = "failed")]
    BakeFailed { message: String },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Section {
    name: String,
    title: String,
    author: String,
    license: Option<String>,
    ldraw_org: Option<String>,
}

impl From<&Header> for Section {
    fn from(header: &Header) -> Self {
        Section {
            name: header.name.clone(),
            title: header.title.clone(),
            author: header.author.clone(),
            license: header.license.clone(),
            ldraw_org: header.ldraw_org.clone(),
        }
    }
}

#[derive(Serialize)]
pub struct InlinePair {
    pub inline: String,
    pub official: String,
}

#[derive(Serialize)]
pub struct LooseGeometry {
    pub section: String,
    pub triangles: usize,
    pub quads: usize,
    pub occurrences: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    kind: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    missing: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ldraw_org: Option<String>,
}

impl From<&CompileError> for Failure {
    fn from(error: &CompileError) -> Self {
        let message = error.to_string();
        let failure = |kind| Failure {
            kind,
            message: message.clone(),
            missing: None,
            from: None,
            path: None,
            ldraw_org: None,
        };
        match error {
            CompileError::Flatten(FlattenError::Unresolved { reference, from }) => Failure {
                missing: Some(reference.clone()),
                from: Some(from.clone()),
                ..failure("unresolved")
            },
            CompileError::Flatten(FlattenError::TooDeep { .. }) => failure("tooDeep"),
            CompileError::License { path, .. } => Failure {
                path: Some(path.clone()),
                ..failure("license")
            },
            CompileError::Unofficial { path, ldraw_org } => Failure {
                path: Some(path.clone()),
                ldraw_org: Some(ldraw_org.clone()),
                ..failure("unofficial")
            },
        }
    }
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PartOutcome {
    Compiled {
        reference: String,
        glb: Range,
        file: String,
        header: Section,
        files: usize,
        connectors: Option<serde_json::Value>,
    },
    Need {
        reference: String,
        paths: Vec<String>,
    },
    Failed {
        reference: String,
        #[serde(flatten)]
        failure: Failure,
    },
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InlineOutcome {
    Measured {
        #[serde(flatten)]
        pair: InlinePair,
        max_measured_distance_ldu: f64,
        surface_within_weld: bool,
        inline_colors: Vec<u32>,
        official_colors: Vec<u32>,
        colors_match: bool,
        within_weld: bool,
    },
    Need {
        #[serde(flatten)]
        pair: InlinePair,
        paths: Vec<String>,
    },
    Failed {
        #[serde(flatten)]
        pair: InlinePair,
        #[serde(flatten)]
        failure: Failure,
    },
}

impl InlineOutcome {
    pub fn measured(pair: InlinePair, comparison: &InlineComparison) -> Self {
        InlineOutcome::Measured {
            pair,
            max_measured_distance_ldu: comparison.max_measured_distance,
            surface_within_weld: comparison.surface_within_weld,
            inline_colors: comparison.inline_colors.clone(),
            official_colors: comparison.official_colors.clone(),
            colors_match: comparison.colors_match(),
            within_weld: comparison.equivalent(),
        }
    }
}

#[derive(Serialize)]
pub struct Aabb {
    min: Vec3,
    max: Vec3,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lattice {
    phase: [u32; 2],
    phase_layer_y: f64,
    phase_layer_studs: usize,
    phase_layer_agreeing: usize,
    aabb: Aabb,
}

impl From<&ModelLattice> for Lattice {
    fn from(lattice: &ModelLattice) -> Self {
        Lattice {
            phase: lattice.phase,
            phase_layer_y: lattice.phase_layer_y,
            phase_layer_studs: lattice.phase_layer_studs,
            phase_layer_agreeing: lattice.phase_layer_agreeing,
            aabb: Aabb {
                min: lattice.aabb_min,
                max: lattice.aabb_max,
            },
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cells {
    origin: [f64; 2],
    size: [usize; 2],
    bottom_y: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cover {
    studs: usize,
    covered_studs: usize,
    kept_open_below: usize,
    cells: Option<Cells>,
}

impl From<&ModelCover> for Cover {
    fn from(cover: &ModelCover) -> Self {
        Cover {
            studs: cover.visible.len(),
            covered_studs: cover.covered_count(),
            kept_open_below: cover.open_below,
            cells: cover.cells.as_ref().map(|cells| Cells {
                origin: cells.origin,
                size: [cells.width, cells.depth],
                bottom_y: cells.bottom_y,
            }),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BogieHeader {
    pub instances: Range,
    pub pivot: Vec3,
    pub axles: Vec<Vec3>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WheelsetHeader {
    instance: usize,
    centre: Vec3,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CouplerHeader {
    instance: usize,
    face: Vec3,
    bogie: Option<usize>,
    obsolete_sources: Vec<String>,
}

impl From<&Coupler> for CouplerHeader {
    fn from(coupler: &Coupler) -> Self {
        CouplerHeader {
            instance: coupler.instance,
            face: coupler.face,
            bogie: coupler.bogie,
            obsolete_sources: coupler.obsolete_sources.clone(),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RailContactHeader {
    rail_part: String,
    rail_top_y: f64,
    spread_ldu: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VehicleHeader {
    origin: [f64; 2],
    yaw: f64,
    guide_kind: &'static str,
    guides: [f64; 2],
    body: Range,
    bogies: Vec<BogieHeader>,
    fixed_axles: Vec<Vec3>,
    wheelsets: Vec<WheelsetHeader>,
    front_coupler: Option<CouplerHeader>,
    rear_coupler: Option<CouplerHeader>,
    rail_contacts: Vec<RailContactHeader>,
}

impl VehicleHeader {
    pub fn new(vehicle: &Vehicle, body: Range, bogies: Vec<BogieHeader>) -> Self {
        VehicleHeader {
            origin: vehicle.origin,
            yaw: vehicle.yaw,
            guide_kind: match vehicle.guide_kind {
                GuideKind::BogiePivot => "bogiePivot",
                GuideKind::FixedAxle => "fixedAxle",
            },
            guides: vehicle.guides,
            body,
            bogies,
            fixed_axles: vehicle.fixed_axles.clone(),
            wheelsets: vehicle
                .wheelsets
                .iter()
                .map(|wheelset| WheelsetHeader {
                    instance: wheelset.instance,
                    centre: wheelset.centre,
                })
                .collect(),
            front_coupler: vehicle.front_coupler.as_ref().map(CouplerHeader::from),
            rear_coupler: vehicle.rear_coupler.as_ref().map(CouplerHeader::from),
            rail_contacts: vehicle
                .rail_contacts
                .iter()
                .map(|contact| RailContactHeader {
                    rail_part: contact.rail_part.clone(),
                    rail_top_y: contact.rail_top_y,
                    spread_ldu: contact.spread,
                })
                .collect(),
        }
    }
}

impl From<StudioArchive> for Reply {
    fn from(archive: StudioArchive) -> Self {
        Reply::StudioRead {
            entry: archive.entry,
            ldraw: archive.ldraw,
            studio_version: archive.studio_version,
            converted_lines: archive.converted_lines,
            unconverted_lines: archive.unconverted_lines,
            bricklink_ids: archive.bricklink_ids,
            custom_parts: archive.custom_parts,
        }
    }
}

impl From<StudioError> for Reply {
    fn from(error: StudioError) -> Self {
        Reply::StudioRejected {
            kind: match error {
                StudioError::NotZip(_) => "notZip",
                StudioError::Encrypted => "encrypted",
                StudioError::NoModel { .. } => "noModel",
            },
            message: error.to_string(),
        }
    }
}
