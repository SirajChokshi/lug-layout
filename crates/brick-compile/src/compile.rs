use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::flatten::{FlattenError, Flattened, Flattener, Library, Lod, StudReference};
use crate::glb;
use crate::license::LicenseVerdict;
use crate::mesh::{self, Mesh};
use crate::occlusion;
use crate::technic::{self, TechnicPart, TechnicPrimitives};
use crate::voxel::VOXEL_NOTE;

pub const MODIFIED_NOTE: &str =
    "Modified from LDraw: sub-files flattened, BFC winding resolved, studs extracted, converted to +Y up";

pub fn modified_note(lod: Lod) -> String {
    const LOW_PRIMITIVES: &str = "8-segment p/8 primitives used where LDraw provides them";
    match lod {
        Lod::Standard => MODIFIED_NOTE.to_string(),
        Lod::Low => format!("{MODIFIED_NOTE}, {LOW_PRIMITIVES}"),
        Lod::Far => {
            format!("{MODIFIED_NOTE}, {LOW_PRIMITIVES}, triangles hidden from above removed; {VOXEL_NOTE}")
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum CompileError {
    Flatten(FlattenError),
    License {
        path: String,
        verdict: LicenseVerdict,
    },
    Unofficial {
        path: String,
        ldraw_org: String,
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CompileOptions {
    pub lod: Lod,
    pub stud_primitives: Vec<String>,
    pub unofficial_allowlist: Vec<String>,
    pub technic: TechnicPrimitives,
}

const UNOFFICIAL_PREFIX: &str = "Unofficial_";

impl std::fmt::Display for CompileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CompileError::Flatten(FlattenError::Unresolved { reference, from }) => {
                write!(f, "unresolved reference {reference} in {from}")
            }
            CompileError::Flatten(FlattenError::TooDeep { path }) => {
                write!(f, "sub-file nesting too deep at {path}")
            }
            CompileError::License { path, verdict } => {
                write!(f, "license gate rejected {path}: {verdict:?}")
            }
            CompileError::Unofficial { path, ldraw_org } => {
                write!(
                    f,
                    "license gate rejected unofficial {path} ({ldraw_org}) not on the allowlist"
                )
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct CompiledPart {
    pub path: String,
    pub mesh: Mesh,
    pub studs: Vec<StudReference>,
    pub flattened_files: Vec<crate::flatten::VisitedFile>,
    pub technic: Option<TechnicPart>,
}

fn to_y_up(p: Vec3) -> Vec3 {
    Affine::LDRAW_TO_Y_UP.apply(p).map(|v| v + 0.0)
}

pub fn license_gate(
    flattened: &Flattened,
    unofficial_allowlist: &[String],
) -> Result<(), CompileError> {
    for file in &flattened.files {
        if !file.license.is_shippable() {
            return Err(CompileError::License {
                path: file.path.clone(),
                verdict: file.license.clone(),
            });
        }
        let ldraw_org = file.header.ldraw_org.as_deref().unwrap_or_default();
        if ldraw_org.starts_with(UNOFFICIAL_PREFIX) && !unofficial_allowlist.contains(&file.path) {
            return Err(CompileError::Unofficial {
                path: file.path.clone(),
                ldraw_org: ldraw_org.to_string(),
            });
        }
    }
    Ok(())
}

pub fn compile_part<L: Library>(
    library: &L,
    reference: &str,
    options: &CompileOptions,
) -> Result<CompiledPart, CompileError> {
    let mut flattener = Flattener::new(library, options.lod, &options.stud_primitives);
    let path =
        flattener
            .resolve(reference)
            .ok_or(CompileError::Flatten(FlattenError::Unresolved {
                reference: reference.to_string(),
                from: String::new(),
            }))?;
    let mut flattened = flattener.flatten(&path).map_err(CompileError::Flatten)?;
    license_gate(&flattened, &options.unofficial_allowlist)?;
    for triangle in &mut flattened.triangles {
        triangle.points = triangle.points.map(to_y_up);
    }
    if options.lod == Lod::Far {
        occlusion::drop_hidden_from_above(&mut flattened.triangles);
    }
    for edge in &mut flattened.hard_edges {
        *edge = edge.map(to_y_up);
    }
    let mesh = mesh::build(&flattened.triangles, &flattened.hard_edges);
    let technic = if options.technic.appear_in(&flattened.files) {
        technic_features(library, &path, &options.technic, &mesh)?
    } else {
        None
    };
    let studs = flattened
        .studs
        .iter()
        .map(|stud| StudReference {
            primitive: stud.primitive.clone(),
            color: stud.color,
            matrix: Affine {
                m: stud.matrix.ldraw_to_y_up().m.map(|v| v + 0.0),
            },
        })
        .collect();
    Ok(CompiledPart {
        path,
        mesh,
        studs,
        flattened_files: flattened.files,
        technic,
    })
}

fn technic_features<L: Library>(
    library: &L,
    path: &str,
    primitives: &TechnicPrimitives,
    mesh: &Mesh,
) -> Result<Option<TechnicPart>, CompileError> {
    let Some([min, max]) = mesh.bounds() else {
        return Ok(None);
    };
    let shape_reference = |reference: &str| primitives.shape_reference(reference);
    let mut flattened = Flattener::new(library, Lod::Standard, &[])
        .recording_spans(&shape_reference)
        .flatten(path)
        .map_err(CompileError::Flatten)?;
    for triangle in &mut flattened.triangles {
        triangle.points = triangle.points.map(to_y_up);
    }
    for span in &mut flattened.spans {
        span.matrix = span.matrix.ldraw_to_y_up();
    }
    let part = technic::analyze(
        &flattened.triangles,
        &flattened.spans,
        primitives,
        [min.map(f64::from), max.map(f64::from)],
    );
    Ok((!part.is_empty()).then_some(part))
}

impl CompiledPart {
    pub fn extras(&self) -> Value {
        let top = &self.flattened_files[0].header;
        let sources: Vec<Value> = self
            .flattened_files
            .iter()
            .map(|f| {
                json!({
                    "path": f.path,
                    "author": f.header.author,
                    "license": f.header.license,
                })
            })
            .collect();
        let studs: Vec<Value> = self
            .studs
            .iter()
            .map(|s| json!({ "primitive": s.primitive, "color": s.color, "matrix": s.matrix.m }))
            .collect();
        let [min, max] = self.mesh.bounds().unwrap_or([[0.0; 3]; 2]);
        let mut extras = json!({
            "unit": "LDU",
            "upAxis": "+Y",
            "ldraw": {
                "file": self.path,
                "name": top.name,
                "title": top.title,
                "author": top.author,
                "license": top.license,
                "ldrawOrg": top.ldraw_org,
                "note": MODIFIED_NOTE,
            },
            "sources": sources,
            "studs": studs,
            "bounds": { "min": min, "max": max },
        });
        if let Some(technic) = &self.technic {
            extras["technic"] = technic.to_json();
        }
        extras
    }

    pub fn to_glb(&self) -> Vec<u8> {
        glb::write(&self.path, &self.mesh, self.extras())
    }
}
