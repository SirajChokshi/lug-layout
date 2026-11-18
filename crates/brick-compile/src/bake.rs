use std::collections::{HashMap, HashSet};

use crate::affine::{Affine, Vec3};
use crate::compile::{compile_part, CompileError, CompileOptions, CompiledPart, RollingMode};
use crate::cover::{
    model_cover, CoverInstance, CoverShard, ModelCover, Opacity, PartSolid, StudShape,
};
use crate::flatten::{Library, Lod};
use crate::lattice::{model_lattice, LatticeError, LatticeInstance, ModelLattice};
use crate::model::ModelInstance;
use crate::vehicle::{detect_vehicles, RailHeadBand, Vehicle, VehicleError, VehicleSignatures};
use crate::voxel::{voxelize, VoxelError, VoxelGrid, VoxelPart};

#[derive(Clone, Debug, PartialEq)]
pub enum BakeError {
    Compile(CompileError),
    StudPrimitiveEmpty {
        name: String,
    },
    StudCount {
        part: String,
        standard: usize,
        shape: usize,
    },
    Voxel(VoxelError),
}

impl std::fmt::Display for BakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BakeError::Compile(error) => write!(f, "{error}"),
            BakeError::StudPrimitiveEmpty { name } => {
                write!(f, "stud primitive {name} has no geometry")
            }
            BakeError::StudCount {
                part,
                standard,
                shape,
            } => write!(
                f,
                "{part} has {standard} studs at the standard LOD but {shape} in this bundle"
            ),
            BakeError::Voxel(error) => write!(f, "{error}"),
        }
    }
}

impl From<CompileError> for BakeError {
    fn from(error: CompileError) -> Self {
        BakeError::Compile(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct LatticeShape {
    pub studs: Vec<Vec3>,
    pub bounds: [Vec3; 2],
}

impl LatticeShape {
    pub fn of(part: &CompiledPart) -> Self {
        LatticeShape {
            studs: part
                .studs
                .iter()
                .map(|stud| [stud.matrix.m[3], stud.matrix.m[7], stud.matrix.m[11]])
                .collect(),
            bounds: part
                .mesh
                .bounds()
                .unwrap_or([[0.0; 3]; 2])
                .map(|corner| corner.map(f64::from)),
        }
    }
}

pub fn drawn_lattice(
    drawn: &[ModelInstance],
    shapes: &[&LatticeShape],
) -> Result<Option<ModelLattice>, LatticeError> {
    let instances: Vec<LatticeInstance> = drawn
        .iter()
        .zip(shapes)
        .map(|(instance, shape)| LatticeInstance {
            matrix: &instance.matrix,
            studs: &shape.studs,
            bounds_min: shape.bounds[0],
            bounds_max: shape.bounds[1],
        })
        .collect();
    match model_lattice(&instances) {
        Ok(lattice) => Ok(Some(lattice)),
        Err(LatticeError::NoIntegerPhaseStuds) => Ok(None),
        Err(error) => Err(error),
    }
}

pub struct ModelBaker<'a, L: Library> {
    library: &'a L,
    options: CompileOptions,
    stud_shape: StudShape,
    translucent: HashSet<u32>,
    opacity: Opacity,
    index: HashMap<String, usize>,
    compiled: Vec<CompiledPart>,
    solids: Vec<PartSolid>,
    studs: Vec<Vec<Affine>>,
    table_depth: f64,
}

impl<'a, L: Library> ModelBaker<'a, L> {
    pub fn new(
        library: &'a L,
        stud_primitives: Vec<String>,
        unofficial_allowlist: Vec<String>,
        translucent: HashSet<u32>,
        table_depth: f64,
    ) -> Result<Self, BakeError> {
        let options = CompileOptions {
            lod: Lod::Standard,
            rolling_mode: RollingMode::Skip,
            stud_primitives,
            unofficial_allowlist,
        };
        let stud_shape = measured_stud_shape(library, &options)?;
        Ok(ModelBaker {
            library,
            stud_shape,
            opacity: Opacity::new(translucent.iter().copied()),
            translucent,
            options,
            index: HashMap::new(),
            compiled: Vec::new(),
            solids: Vec::new(),
            studs: Vec::new(),
            table_depth,
        })
    }

    fn slot(&mut self, reference: &str) -> Result<usize, BakeError> {
        if let Some(&slot) = self.index.get(reference) {
            return Ok(slot);
        }
        let compiled = compile_part(self.library, reference, &self.options)?;
        self.solids.push(PartSolid::from_mesh(&compiled.mesh));
        self.studs
            .push(compiled.studs.iter().map(|stud| stud.matrix).collect());
        self.compiled.push(compiled);
        let slot = self.compiled.len() - 1;
        self.index.insert(reference.to_string(), slot);
        Ok(slot)
    }

    fn slots(&mut self, drawn: &[ModelInstance]) -> Result<Vec<usize>, BakeError> {
        drawn
            .iter()
            .map(|instance| self.slot(&instance.part))
            .collect()
    }

    pub fn standard_part(&mut self, reference: &str) -> Result<&CompiledPart, BakeError> {
        let slot = self.slot(reference)?;
        Ok(&self.compiled[slot])
    }

    pub fn stud_total(
        &mut self,
        drawn: &[ModelInstance],
        shapes: &[&LatticeShape],
    ) -> Result<usize, BakeError> {
        let mut total = 0;
        for (instance, shape) in drawn.iter().zip(shapes) {
            let slot = self.slot(&instance.part)?;
            let standard = self.studs[slot].len();
            if standard != shape.studs.len() {
                return Err(BakeError::StudCount {
                    part: instance.part.clone(),
                    standard,
                    shape: shape.studs.len(),
                });
            }
            total += standard;
        }
        Ok(total)
    }

    pub fn cover(
        &mut self,
        drawn: &[ModelInstance],
        lattice: Option<&ModelLattice>,
        shard: CoverShard,
    ) -> Result<ModelCover, BakeError> {
        let slots = self.slots(drawn)?;
        let instances: Vec<CoverInstance> = drawn
            .iter()
            .zip(&slots)
            .map(|(instance, &slot)| CoverInstance {
                matrix: &instance.matrix,
                color: instance.color,
                part: slot,
                studs: &self.studs[slot],
            })
            .collect();
        Ok(model_cover(
            &instances,
            &self.solids,
            &self.opacity,
            lattice.map(|lattice| (lattice.phase, lattice.phase_layer_y)),
            self.stud_shape,
            shard,
            self.table_depth,
        ))
    }

    pub fn vehicles(
        &self,
        drawn: &[ModelInstance],
        signatures: &VehicleSignatures,
        rails: &[RailHeadBand],
    ) -> Result<Vec<Vehicle>, VehicleError> {
        detect_vehicles(self.library, drawn, signatures, rails)
    }

    pub fn voxels(&mut self, drawn: &[ModelInstance]) -> Result<Option<VoxelGrid>, BakeError> {
        let slots = self.slots(drawn)?;
        let parts: Vec<VoxelPart> = drawn
            .iter()
            .zip(&slots)
            .map(|(instance, &slot)| VoxelPart {
                mesh: &self.compiled[slot].mesh,
                studs: &self.compiled[slot].studs,
                color: instance.color,
                matrix: &instance.matrix,
            })
            .collect();
        match voxelize(&parts, &self.translucent) {
            Ok(grid) => Ok(Some(grid)),
            Err(VoxelError::Lattice(LatticeError::NoIntegerPhaseStuds)) => Ok(None),
            Err(error) => Err(BakeError::Voxel(error)),
        }
    }
}

fn measured_stud_shape<L: Library>(
    library: &L,
    options: &CompileOptions,
) -> Result<StudShape, BakeError> {
    let bare = CompileOptions {
        stud_primitives: Vec::new(),
        ..options.clone()
    };
    let mut shape = StudShape {
        height: 0.0,
        radius: 0.0,
    };
    for name in &options.stud_primitives {
        let compiled = compile_part(library, name, &bare)?;
        let [min, max] = compiled
            .mesh
            .bounds()
            .ok_or_else(|| BakeError::StudPrimitiveEmpty { name: name.clone() })?;
        shape.height = shape.height.max(f64::from(max[1]));
        shape.radius = shape
            .radius
            .max(f64::from(max[0] - min[0]) / 2.0)
            .max(f64::from(max[2] - min[2]) / 2.0);
    }
    Ok(shape)
}
