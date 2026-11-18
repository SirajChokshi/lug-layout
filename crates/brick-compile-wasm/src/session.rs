#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};

use brick_compile::bake::{drawn_lattice, LatticeShape, ModelBaker};
use brick_compile::compile::{stud_roundness, NO_STUD_RING};
use brick_compile::cover::ModelCover;
use brick_compile::flatten::Flattener;
use brick_compile::inline::compare_inline_part;
use brick_compile::mesh::WELD_EPSILON_LDU;
use brick_compile::model::{bake_model, ModelInstance};
use brick_compile::studio::read_io;
use brick_compile::vehicle::Vehicle;
use brick_compile::{compile_part, CompileError, CompileOptions, Lod};

use crate::frame::{respond, split, Body, Request};
use crate::reply::{
    BogieHeader, Cover, Failure, InlineOutcome, InlinePair, Lattice, LooseGeometry, PartOutcome,
    Reply, Section, VehicleHeader,
};
use crate::request::{InlineCheck, Operation, Range, VehicleInputs};
use crate::tracking::TrackingLibrary;

#[derive(Default)]
pub struct Session {
    library: TrackingLibrary,
}

struct BakeInputs<'a> {
    stud_primitives: &'a [String],
    unofficial_allowlist: &'a [String],
    translucent: HashSet<u32>,
    vehicles: Option<&'a VehicleInputs>,
}

impl Session {
    pub fn handle(&mut self, input: &[u8]) -> Vec<u8> {
        let mut body = Body::default();
        let reply = self
            .dispatch(input, &mut body)
            .unwrap_or_else(|message| Reply::Error { message });
        respond(&reply, &body.into_bytes())
    }

    fn dispatch(&mut self, input: &[u8], body: &mut Body) -> Result<Reply, String> {
        let request = split(input)?;
        self.extend_library(&request)?;
        match &request.envelope.request {
            Operation::ReadModel => read_model(&request.text("source")?, body),
            Operation::ReadStudio => Ok(match read_io(request.segment("io")?) {
                Ok(archive) => Reply::from(archive),
                Err(error) => Reply::from(error),
            }),
            Operation::Compile {
                lod,
                stud_primitives,
                unofficial_allowlist,
                parts,
                inline_checks,
            } => {
                let roundness = stud_roundness(&self.library, stud_primitives);
                let stud_needs = self.library.take_requested();
                if roundness.is_none() && stud_needs.is_empty() {
                    return Err(NO_STUD_RING.to_string());
                }
                let options = CompileOptions {
                    lod: Lod::from(*lod),
                    stud_primitives: stud_primitives.clone(),
                    unofficial_allowlist: unofficial_allowlist.clone(),
                    roundness,
                };
                let model = request.text("source")?;
                Ok(compile(
                    &self.library,
                    &options,
                    CompileWork {
                        references: parts,
                        inline_checks,
                        stud_needs: &stud_needs,
                    },
                    &model,
                    body,
                ))
            }
            Operation::Bake {
                stud_primitives,
                unofficial_allowlist,
                translucent_colors,
                vehicles,
            } => {
                let drawn = drawn_instances(&request.text("source")?, request.segment("drawn")?)?;
                let inputs = BakeInputs {
                    stud_primitives,
                    unofficial_allowlist,
                    translucent: translucent_colors.iter().copied().collect(),
                    vehicles: vehicles.as_ref(),
                };
                Ok(bake(&self.library, &drawn, &inputs, body))
            }
        }
    }

    fn extend_library(&mut self, request: &Request) -> Result<(), String> {
        let Some(library) = &request.envelope.library else {
            return Ok(());
        };
        let mut files = Vec::with_capacity(library.files.len());
        for file in &library.files {
            let text = String::from_utf8(request.range(file.bytes)?.to_vec())
                .map_err(|e| format!("library file {} is not UTF-8: {e}", file.path))?;
            files.push((file.path.clone(), text));
        }
        self.library
            .extend(&library.key, files, library.absent.iter().cloned());
        Ok(())
    }
}

fn read_model(source: &str, body: &mut Body) -> Result<Reply, String> {
    let model = bake_model(source).map_err(|e| e.to_string())?;
    let mut part_ids: Vec<String> = Vec::new();
    let mut part_index: HashMap<&str, u32> = HashMap::new();
    let count = model.instances.len();
    let mut parts = Vec::with_capacity(count);
    let mut colors = Vec::with_capacity(count);
    let mut matrices: Vec<f32> = Vec::with_capacity(count * 12);
    for instance in &model.instances {
        let key = instance.inline.as_deref().unwrap_or(&instance.part);
        let next = u32::try_from(part_ids.len()).map_err(|e| e.to_string())?;
        let index = *part_index.entry(key).or_insert_with(|| {
            part_ids.push(key.to_string());
            next
        });
        parts.push(index);
        colors.push(instance.color);
        matrices.extend(instance.matrix.m.map(|v| v as f32));
    }
    body.blob("instancePart", &parts);
    body.blob("instanceColor", &colors);
    body.blob("instanceMatrix", &matrices);
    Ok(Reply::ModelRead {
        sections: model.sections.iter().map(Section::from).collect(),
        parts: part_ids,
        inline_parts: model
            .inline_parts
            .into_iter()
            .map(|part| InlinePair {
                inline: part.inline,
                official: part.official,
            })
            .collect(),
        loose_geometry: model
            .loose_geometry
            .into_iter()
            .map(|loose| LooseGeometry {
                section: loose.section,
                triangles: loose.triangles,
                quads: loose.quads,
                occurrences: loose.occurrences,
            })
            .collect(),
        instances: count,
        blobs: body.take_blobs(),
    })
}

struct CompileWork<'a> {
    references: &'a [String],
    inline_checks: &'a [InlineCheck],
    stud_needs: &'a [String],
}

fn compile(
    library: &TrackingLibrary,
    options: &CompileOptions,
    work: CompileWork,
    model: &str,
    body: &mut Body,
) -> Reply {
    let CompileWork {
        references,
        inline_checks,
        stud_needs,
    } = work;
    let mut parts = Vec::with_capacity(references.len());
    for reference in references {
        let result = compile_part(library, reference, options);
        let mut requested = library.take_requested();
        requested.extend(stud_needs.iter().cloned());
        let reference = reference.clone();
        parts.push(match result {
            _ if !requested.is_empty() => PartOutcome::Need {
                reference,
                paths: requested,
            },
            Ok(compiled) => PartOutcome::Compiled {
                reference,
                glb: body.bytes(&compiled.to_glb()),
                file: compiled.path.clone(),
                header: Section::from(&compiled.flattened_files[0].header),
                files: compiled.flattened_files.len(),
            },
            Err(error) => PartOutcome::Failed {
                reference,
                failure: Failure::from(&error),
            },
        });
    }
    let mut inline = Vec::with_capacity(inline_checks.len());
    for check in inline_checks {
        let result = compare_inline_part(library, model, &check.inline, &check.official);
        let requested = library.take_requested();
        let pair = InlinePair {
            inline: check.inline.clone(),
            official: check.official.clone(),
        };
        inline.push(match result {
            _ if !requested.is_empty() => InlineOutcome::Need {
                pair,
                paths: requested,
            },
            Ok(comparison) => InlineOutcome::measured(pair, &comparison),
            Err(error) => InlineOutcome::Failed {
                pair,
                failure: Failure::from(&CompileError::Flatten(error)),
            },
        });
    }
    Reply::Compiled {
        parts,
        inline,
        weld_epsilon_ldu: WELD_EPSILON_LDU,
    }
}

fn drawn_instances(source: &str, mask: &[u8]) -> Result<Vec<ModelInstance>, String> {
    let model = bake_model(source).map_err(|e| e.to_string())?;
    if mask.len() != model.instances.len() {
        return Err(format!(
            "bake got a drawn mask for {} instances, but the model has {}",
            mask.len(),
            model.instances.len()
        ));
    }
    Ok(model
        .instances
        .into_iter()
        .zip(mask)
        .filter(|(_, &drawn)| drawn != 0)
        .map(|(instance, _)| instance)
        .collect())
}

fn bake(
    library: &TrackingLibrary,
    drawn: &[ModelInstance],
    inputs: &BakeInputs,
    body: &mut Body,
) -> Reply {
    let mut scan = Flattener::new(library, Lod::Standard, &[]);
    let mut scanned: HashSet<&str> = HashSet::new();
    for reference in drawn
        .iter()
        .map(|instance| instance.part.as_str())
        .chain(inputs.stud_primitives.iter().map(String::as_str))
    {
        if scanned.insert(reference) {
            scan.closure(reference);
        }
    }
    let requested = library.take_requested();
    if !requested.is_empty() {
        return Reply::Need { paths: requested };
    }
    let baked = bake_drawn(library, drawn, inputs, body);
    let requested = library.take_requested();
    if !requested.is_empty() {
        return Reply::Need { paths: requested };
    }
    baked.unwrap_or_else(|message| Reply::BakeFailed { message })
}

fn bake_drawn(
    library: &TrackingLibrary,
    drawn: &[ModelInstance],
    inputs: &BakeInputs,
    body: &mut Body,
) -> Result<Reply, String> {
    let mut baker = ModelBaker::new(
        library,
        inputs.stud_primitives.to_vec(),
        inputs.unofficial_allowlist.to_vec(),
        inputs.translucent.clone(),
    )
    .map_err(|e| e.to_string())?;
    let mut shapes: HashMap<&str, LatticeShape> = HashMap::new();
    for instance in drawn {
        if !shapes.contains_key(instance.part.as_str()) {
            let compiled = baker
                .standard_part(&instance.part)
                .map_err(|e| format!("{}: {e}", instance.part))?;
            shapes.insert(&instance.part, LatticeShape::of(compiled));
        }
    }
    let drawn_shapes: Vec<&LatticeShape> = drawn
        .iter()
        .map(|instance| &shapes[instance.part.as_str()])
        .collect();
    let (lattice, lattice_issue) = match drawn_lattice(drawn, &drawn_shapes) {
        Ok(lattice) => (lattice, None),
        Err(error) => (None, Some(error.to_string())),
    };
    let cover = baker
        .cover(drawn, lattice.as_ref())
        .map_err(|e| e.to_string())?;
    put_cover(body, &cover)?;
    let (vehicles, vehicle_issue) = match inputs.vehicles {
        None => (None, None),
        Some(vehicles) => match baker.vehicles(drawn, &vehicles.signatures(), &vehicles.rails()) {
            Ok(detected) => (Some(vehicle_headers(body, &detected)?), None),
            Err(error) => (None, Some(error.to_string())),
        },
    };
    Ok(Reply::Baked {
        instances: drawn.len(),
        lattice: lattice.as_ref().map(Lattice::from),
        lattice_issue,
        cover: Cover::from(&cover),
        vehicles,
        vehicle_issue,
        blobs: body.take_blobs(),
    })
}

fn index_range(indices: &[usize], out: &mut Vec<u32>) -> Result<Range, String> {
    let start = out.len();
    for &index in indices {
        out.push(u32::try_from(index).map_err(|e| e.to_string())?);
    }
    Ok((start, indices.len()))
}

fn vehicle_headers(body: &mut Body, vehicles: &[Vehicle]) -> Result<Vec<VehicleHeader>, String> {
    let mut members = Vec::new();
    let mut bogie_instances = Vec::new();
    let mut headers = Vec::with_capacity(vehicles.len());
    for vehicle in vehicles {
        let members_range = index_range(&vehicle.body, &mut members)?;
        let bogies = vehicle
            .bogies
            .iter()
            .map(|bogie| {
                Ok(BogieHeader {
                    instances: index_range(&bogie.instances, &mut bogie_instances)?,
                    pivot: bogie.pivot,
                    axles: bogie.axles.clone(),
                })
            })
            .collect::<Result<Vec<_>, String>>()?;
        headers.push(VehicleHeader::new(vehicle, members_range, bogies));
    }
    body.blob("vehicleBody", &members);
    body.blob("bogieInstances", &bogie_instances);
    Ok(headers)
}

fn plates(columns: &[i32]) -> Result<Vec<i16>, String> {
    columns
        .iter()
        .map(|&plates| i16::try_from(plates).map_err(|e| e.to_string()))
        .collect()
}

fn cell_indices(cells: &[usize]) -> Result<Vec<u32>, String> {
    cells
        .iter()
        .map(|&cell| u32::try_from(cell).map_err(|e| e.to_string()))
        .collect()
}

fn put_cover(body: &mut Body, cover: &ModelCover) -> Result<(), String> {
    if let Some(cells) = &cover.cells {
        body.blob("footprint", &cell_indices(&cells.footprint)?);
        body.blob("flat", &cell_indices(&cells.flat)?);
        body.blob("columnBottom", &plates(&cells.column_bottom)?);
        body.blob("columnTop", &plates(&cells.column_top)?);
    }
    body.blob("visibleBits", &cover.visible_bits());
    Ok(())
}
