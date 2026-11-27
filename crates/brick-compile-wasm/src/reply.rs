#![forbid(unsafe_code)]

use std::collections::BTreeMap;

use brick_compile::affine::Vec3;
use brick_compile::authored::AUTHORED_RULE_VERSION;
use brick_compile::cover::{CellsCause, ModelCover};
use brick_compile::flatten::FlattenError;
use brick_compile::inline::InlineComparison;
use brick_compile::lattice::{Malformation, MalformedGeometry, ModelLattice};
use brick_compile::ldraw::Header;
use brick_compile::model::{AuthoredColumns, RationalText};
use brick_compile::studio::{StudioArchive, StudioError};
use brick_compile::CompileError;
use serde::Serialize;

use crate::request::Range;

pub type Blobs = BTreeMap<&'static str, Range>;

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BakePhases {
    pub decode_ms: f64,
    pub compile_ms: f64,
    pub lattice_ms: f64,
    pub cover_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthoredIdentification {
    rule_version: u32,
    rows: AuthoredRows,
    excluded_rotated: AuthoredLines,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthoredRows {
    line: Vec<usize>,
    line_kind: Vec<&'static str>,
    axis: Vec<u8>,
    printed: Vec<String>,
    grid: Vec<&'static str>,
    identified: Vec<Option<ExactRational>>,
    residual: Vec<Option<ExactRational>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthoredLines {
    line: Vec<usize>,
    line_kind: Vec<&'static str>,
}

#[derive(Serialize)]
struct ExactRational {
    numerator: String,
    denominator: String,
}

impl From<RationalText> for ExactRational {
    fn from(
        RationalText {
            numerator,
            denominator,
        }: RationalText,
    ) -> Self {
        ExactRational {
            numerator,
            denominator,
        }
    }
}

impl From<AuthoredColumns> for AuthoredIdentification {
    fn from(columns: AuthoredColumns) -> Self {
        let rationals = |values: Vec<Option<RationalText>>| {
            values
                .into_iter()
                .map(|v| v.map(ExactRational::from))
                .collect()
        };
        AuthoredIdentification {
            rule_version: AUTHORED_RULE_VERSION,
            rows: AuthoredRows {
                line: columns.line,
                line_kind: columns.line_kind,
                axis: columns.axis,
                printed: columns.printed,
                grid: columns.grid,
                identified: rationals(columns.identified),
                residual: rationals(columns.residual),
            },
            excluded_rotated: AuthoredLines {
                line: columns.excluded_line,
                line_kind: columns.excluded_line_kind,
            },
        }
    }
}

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
        #[serde(skip_serializing_if = "Option::is_none")]
        authored_identification: Option<AuthoredIdentification>,
        authored_poses: Vec<Option<[String; 12]>>,
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
        custom_files: Vec<CustomFileReply>,
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
    #[serde(rename = "complete")]
    Complete,
    #[serde(rename = "baked")]
    Baked {
        instances: usize,
        recorded_parts: usize,
        resumed_parts: usize,
        lattice: Option<Lattice>,
        #[serde(skip_serializing_if = "Option::is_none")]
        lattice_issue: Option<String>,
        cover: Cover,
        phases: BakePhases,
        blobs: Blobs,
    },
    #[serde(rename = "failed")]
    BakeFailed { message: String },
    #[serde(rename = "error")]
    Error { message: String },
}

#[derive(Serialize)]
pub struct InferredRecords {
    pub connectivity: Option<serde_json::Value>,
    pub connectors: Option<serde_json::Value>,
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
pub struct CustomFileReply {
    name: String,
    text: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    findings: Option<Vec<MalformedFinding>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cause: Option<&'static str>,
}

#[derive(Serialize)]
pub struct MalformedFinding {
    file: String,
    kind: &'static str,
}

impl From<&MalformedGeometry> for MalformedFinding {
    fn from(found: &MalformedGeometry) -> Self {
        MalformedFinding {
            file: found.file.clone(),
            kind: match found.malformation {
                Malformation::NonFinite => "nonFinite",
                Malformation::Unparsed => "unparsed",
                Malformation::Unresolvable => "unresolvable",
            },
        }
    }
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
            findings: None,
            cause: None,
        };
        match error {
            CompileError::Flatten(FlattenError::Unresolved { reference, from }) => Failure {
                missing: Some(reference.clone()),
                from: Some(from.clone()),
                ..failure("unresolved")
            },
            CompileError::Flatten(FlattenError::TooDeep { .. }) => failure("tooDeep"),
            CompileError::NoStudRing => failure("noStudRing"),
            CompileError::TooLarge { path, cells, .. } => Failure {
                path: Some(path.clone()),
                cause: Some(match cells.cause {
                    CellsCause::BeyondAddressSpace => "beyondAddressSpace",
                    CellsCause::MemoryUnavailable => "memoryUnavailable",
                }),
                ..failure("tooLarge")
            },
            CompileError::Unofficial { path, ldraw_org } => Failure {
                path: Some(path.clone()),
                ldraw_org: Some(ldraw_org.clone()),
                ..failure("unofficial")
            },
            CompileError::Malformed { findings } => Failure {
                findings: Some(findings.iter().map(MalformedFinding::from).collect()),
                ..failure("malformed")
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
        record: Option<Range>,
        file: String,
        header: Section,
        files: usize,
        connectors: Option<InferredRecords>,
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
            phase_layer_studs: lattice.phase_layer_votes,
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
            custom_files: archive
                .custom_files
                .into_iter()
                .map(|file| CustomFileReply {
                    name: file.name,
                    text: file.text,
                })
                .collect(),
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
