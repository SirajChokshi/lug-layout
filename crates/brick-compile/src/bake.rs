use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use crate::affine::{Affine, Vec3};
use crate::compile::{compile_part, CompileError, CompileOptions, CompiledPart, RollingMode};
use crate::cover::{
    inscribed_radius, model_cover_with, stud_field_collides, AxisSpan, CellsTooLarge,
    CoverInstance, CoverModel, CoverShard, ModelCover, ModelTooLarge, Opacity, PartSolid,
    ProbeCache, StudShape,
};
use crate::flatten::{Library, Lod, StudReference};
use crate::lattice::{model_lattice, AxisPose, LatticeError, LatticeInstance, ModelLattice};
use crate::mesh::Mesh;
use crate::model::ModelInstance;
use crate::record::{BakeRecord, RecordError};
use crate::technic::TechnicPrimitives;
use crate::vehicle::{
    detect_vehicles_with_bounds, RailHeadBand, Vehicle, VehicleError, VehicleSignatures,
};
use crate::voxel::{voxelize, VoxelError, VoxelGrid, VoxelPart};

#[derive(Clone, Debug, PartialEq)]
pub enum BakeError {
    Compile(CompileError),
    StudPrimitiveEmpty {
        name: String,
    },
    StudPrimitiveWithoutWall {
        name: String,
    },
    StudCount {
        part: String,
        standard: usize,
        shape: usize,
    },
    Voxel(VoxelError),
    Cover {
        cells: CellsTooLarge,
        x: Box<PartSpan>,
        z: Box<PartSpan>,
    },
    Record {
        part: String,
        error: RecordError,
    },
    Recorded {
        part: String,
    },
    Lattice(LatticeError),
}

#[derive(Clone, Debug, PartialEq)]
pub struct PartSpan {
    pub from: String,
    pub to: String,
    pub ldu: f64,
}

impl PartSpan {
    fn of(drawn: &[ModelInstance], span: AxisSpan) -> Box<Self> {
        let part = |i: usize| drawn.get(i).map_or_else(String::new, |d| d.part.clone());
        Box::new(PartSpan {
            from: part(span.from),
            to: part(span.to),
            ldu: span.ldu,
        })
    }
}

impl std::fmt::Display for PartSpan {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} LDU from {} to {}", self.ldu, self.from, self.to)
    }
}

pub type RecordShelf = HashMap<String, Arc<BakeRecord>>;

enum PartSource {
    Compiled(Box<CompiledPart>),
    Recorded(Arc<BakeRecord>),
}

impl PartSource {
    fn mesh(&self) -> &Mesh {
        match self {
            PartSource::Compiled(part) => &part.mesh,
            PartSource::Recorded(record) => &record.mesh,
        }
    }

    fn studs(&self) -> &[StudReference] {
        match self {
            PartSource::Compiled(part) => &part.studs,
            PartSource::Recorded(record) => &record.studs,
        }
    }
}

impl std::fmt::Display for BakeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BakeError::Compile(error) => write!(f, "{error}"),
            BakeError::StudPrimitiveEmpty { name } => {
                write!(f, "stud primitive {name} has no geometry")
            }
            BakeError::StudPrimitiveWithoutWall { name } => {
                write!(f, "stud primitive {name} has no upright outer wall")
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
            BakeError::Cover { cells, x, z } => write!(
                f,
                "the drawn parts span {x} along x and {z} along z, and {cells}"
            ),
            BakeError::Record { part, error } => write!(f, "{part}: {error}"),
            BakeError::Recorded { part } => {
                write!(
                    f,
                    "{part} came from a bake record, so it has no compiled sources"
                )
            }
            BakeError::Lattice(error) => write!(f, "{error}"),
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
    pub studs: Vec<AxisPose>,
    pub receptors: Vec<AxisPose>,
    pub bounds: [Vec3; 2],
}

impl LatticeShape {
    pub fn of(part: &CompiledPart) -> Self {
        LatticeShape::of_parts(&part.mesh, &part.studs)
    }

    fn of_parts(mesh: &Mesh, studs: &[StudReference]) -> Self {
        LatticeShape {
            studs: studs
                .iter()
                .map(|stud| AxisPose::of(&stud.matrix))
                .collect(),
            receptors: Vec::new(),
            bounds: mesh
                .bounds()
                .unwrap_or([[0.0; 3]; 2])
                .map(|corner| corner.map(f64::from)),
        }
    }

    pub fn with_receptors(self, receptors: Vec<AxisPose>) -> Self {
        LatticeShape { receptors, ..self }
    }
}

pub struct ModelBaker<'a, L: Library> {
    library: &'a L,
    options: CompileOptions,
    stud_shape: StudShape,
    translucent: HashSet<u32>,
    opacity: Opacity,
    index: HashMap<String, usize>,
    records: Option<&'a RecordShelf>,
    sources: Vec<PartSource>,
    solids: Vec<PartSolid>,
    studs: Vec<Vec<Affine>>,
    probes: ProbeCache,
    table_depth: f64,
}

pub struct KeptParts {
    options: CompileOptions,
    stud_shape: StudShape,
    translucent: HashSet<u32>,
    opacity: Opacity,
    index: HashMap<String, usize>,
    sources: Vec<PartSource>,
    solids: Vec<PartSolid>,
    studs: Vec<Vec<Affine>>,
    probes: ProbeCache,
    table_depth: f64,
}

impl KeptParts {
    pub fn part_count(&self) -> usize {
        self.sources.len()
    }

    pub fn serves(
        &self,
        stud_primitives: &[String],
        unofficial_allowlist: &[String],
        translucent: &HashSet<u32>,
        table_depth: f64,
    ) -> bool {
        self.options.stud_primitives == stud_primitives
            && self.options.unofficial_allowlist == unofficial_allowlist
            && &self.translucent == translucent
            && self.table_depth.to_bits() == table_depth.to_bits()
    }
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
            technic: TechnicPrimitives::default(),
        };
        let stud_shape = measured_stud_shape(library, &options)?;
        Ok(ModelBaker {
            library,
            stud_shape,
            opacity: Opacity::new(translucent.iter().copied()),
            translucent,
            options,
            index: HashMap::new(),
            records: None,
            sources: Vec::new(),
            solids: Vec::new(),
            studs: Vec::new(),
            probes: ProbeCache::default(),
            table_depth,
        })
    }

    pub fn with_records(mut self, records: &'a RecordShelf) -> Self {
        self.records = Some(records);
        self
    }

    pub fn resume(library: &'a L, kept: KeptParts) -> Self {
        let KeptParts {
            options,
            stud_shape,
            translucent,
            opacity,
            index,
            sources,
            solids,
            studs,
            probes,
            table_depth,
        } = kept;
        ModelBaker {
            library,
            options,
            stud_shape,
            translucent,
            opacity,
            index,
            records: None,
            sources,
            solids,
            studs,
            probes,
            table_depth,
        }
    }

    pub fn keep(self) -> KeptParts {
        let ModelBaker {
            options,
            stud_shape,
            translucent,
            opacity,
            index,
            sources,
            solids,
            studs,
            probes,
            table_depth,
            ..
        } = self;
        KeptParts {
            options,
            stud_shape,
            translucent,
            opacity,
            index,
            sources,
            solids,
            studs,
            probes,
            table_depth,
        }
    }

    fn slot(&mut self, reference: &str) -> Result<usize, BakeError> {
        if let Some(&slot) = self.index.get(reference) {
            return Ok(slot);
        }
        let source = match self.records.and_then(|shelf| shelf.get(reference)) {
            Some(record) => {
                let solid = PartSolid::from_record(record).map_err(|error| BakeError::Record {
                    part: reference.to_string(),
                    error,
                })?;
                self.solids.push(solid);
                PartSource::Recorded(Arc::clone(record))
            }
            None => {
                let compiled = compile_part(self.library, reference, &self.options)?;
                self.solids.push(PartSolid::from_mesh(&compiled.mesh));
                PartSource::Compiled(Box::new(compiled))
            }
        };
        self.studs
            .push(source.studs().iter().map(|stud| stud.matrix).collect());
        self.sources.push(source);
        let slot = self.sources.len() - 1;
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
        match &self.sources[slot] {
            PartSource::Compiled(part) => Ok(part),
            PartSource::Recorded(_) => Err(BakeError::Recorded {
                part: reference.to_string(),
            }),
        }
    }

    pub fn recorded_parts(&self) -> usize {
        self.sources
            .iter()
            .filter(|source| matches!(source, PartSource::Recorded(_)))
            .count()
    }

    pub fn lattice_shape(&mut self, reference: &str) -> Result<LatticeShape, BakeError> {
        let slot = self.slot(reference)?;
        let source = &self.sources[slot];
        Ok(LatticeShape::of_parts(source.mesh(), source.studs()))
    }

    pub fn lattice(
        &mut self,
        drawn: &[ModelInstance],
        shapes: &[&LatticeShape],
    ) -> Result<Option<ModelLattice>, BakeError> {
        let slots = self.slots(drawn)?;
        let lattice_instances: Vec<LatticeInstance> = drawn
            .iter()
            .zip(shapes)
            .map(|(instance, shape)| LatticeInstance {
                matrix: &instance.matrix,
                studs: &shape.studs,
                receptors: &shape.receptors,
                bounds_min: shape.bounds[0],
                bounds_max: shape.bounds[1],
            })
            .collect();
        let cover_instances: Vec<CoverInstance> = drawn
            .iter()
            .zip(&slots)
            .map(|(instance, &slot)| CoverInstance {
                matrix: &instance.matrix,
                color: instance.color,
                part: slot,
                studs: &self.studs[slot],
            })
            .collect();
        let (solids, stud) = (&self.solids, self.stud_shape);
        let seated = model_lattice(&lattice_instances, |phase, floor_y| {
            stud_field_collides(&cover_instances, solids, stud, phase, floor_y)
        });
        match seated {
            Ok(lattice) => Ok(Some(lattice)),
            Err(LatticeError::NoIntegerPhase) => Ok(None),
            Err(error) => Err(BakeError::Lattice(error)),
        }
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
        let model = CoverModel {
            instances: &instances,
            solids: &self.solids,
            opacity: &self.opacity,
            stud: self.stud_shape,
        };
        model_cover_with(
            &model,
            lattice.map(|lattice| (lattice.phase, lattice.phase_layer_y)),
            shard,
            self.table_depth,
            &mut self.probes,
        )
        .map_err(|ModelTooLarge { cells, x, z }| BakeError::Cover {
            cells,
            x: PartSpan::of(drawn, x),
            z: PartSpan::of(drawn, z),
        })
    }

    pub fn vehicles(
        &self,
        drawn: &[ModelInstance],
        signatures: &VehicleSignatures,
        rails: &[RailHeadBand],
    ) -> Result<Vec<Vehicle>, VehicleError> {
        let recorded = self
            .index
            .iter()
            .filter_map(|(reference, &slot)| match &self.sources[slot] {
                PartSource::Recorded(record) => Some((reference.clone(), record.whole_bounds)),
                PartSource::Compiled(_) => None,
            })
            .collect();
        detect_vehicles_with_bounds(self.library, drawn, signatures, rails, recorded)
    }

    pub fn voxels(
        &mut self,
        drawn: &[ModelInstance],
        lattice: Option<&ModelLattice>,
    ) -> Result<FarVoxels, BakeError> {
        let Some(lattice) = lattice else {
            return Ok(FarVoxels::Omitted(VoxelError::NoLattice));
        };
        let slots = self.slots(drawn)?;
        let parts: Vec<VoxelPart> = drawn
            .iter()
            .zip(&slots)
            .map(|(instance, &slot)| VoxelPart {
                mesh: self.sources[slot].mesh(),
                color: instance.color,
                matrix: &instance.matrix,
            })
            .collect();
        match voxelize(&parts, lattice, &self.translucent) {
            Ok(grid) => Ok(FarVoxels::Grid(grid)),
            Err(reason @ VoxelError::FractionalPhaseLayer(_)) => Ok(FarVoxels::Omitted(reason)),
            Err(error) => Err(BakeError::Voxel(error)),
        }
    }
}

#[derive(Debug)]
pub enum FarVoxels {
    Grid(VoxelGrid),
    Omitted(VoxelError),
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
        inscribed_radius: f64::INFINITY,
    };
    for name in &options.stud_primitives {
        let compiled = compile_part(library, name, &bare)?;
        let [min, max] = compiled
            .mesh
            .bounds()
            .ok_or_else(|| BakeError::StudPrimitiveEmpty { name: name.clone() })?;
        let inscribed = inscribed_radius(&compiled.mesh)
            .ok_or_else(|| BakeError::StudPrimitiveWithoutWall { name: name.clone() })?;
        shape.height = shape.height.max(f64::from(max[1]));
        shape.radius = shape
            .radius
            .max(f64::from(max[0] - min[0]) / 2.0)
            .max(f64::from(max[2] - min[2]) / 2.0);
        shape.inscribed_radius = shape.inscribed_radius.min(inscribed);
    }
    Ok(shape)
}
