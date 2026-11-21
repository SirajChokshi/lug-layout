#![forbid(unsafe_code)]

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use brick_compile::bake::{drawn_lattice, KeptParts, LatticeShape, ModelBaker, RecordShelf};
use brick_compile::compile::rolling_mode_from_studs;
use brick_compile::cover::{CoverShard, ModelCover};
use brick_compile::flatten::Flattener;
use brick_compile::inline::compare_inline_part;
use brick_compile::mesh::WELD_EPSILON_LDU;
use brick_compile::model::{bake_model_with, submodel_index, BakeOptions, ModelInstance};
use brick_compile::record::BakeRecord;
use brick_compile::studio::read_io;
use brick_compile::vehicle::{part_bounds, Vehicle};
use brick_compile::{
    compile_part, CompileError, CompileOptions, CompiledPart, Lod, TechnicPrimitives,
};

const BAKE_RECORD_LOD: &str = "bake records exist only at the standard LOD";
const MS_PER_SECOND: f64 = 1000.0;

fn ms(elapsed: Duration) -> f64 {
    elapsed.as_secs_f64() * MS_PER_SECOND
}
static NO_RECORDS: std::sync::LazyLock<RecordShelf> = std::sync::LazyLock::new(RecordShelf::new);

use crate::connectors::ConnectorInference;
use crate::frame::{respond, split, Body, Request};
use crate::reply::{
    AuthoredIdentification, BakePhases, BogieHeader, Cover, Failure, InlineOutcome, InlinePair,
    Lattice, LooseGeometry, PartOutcome, Reply, Section, VehicleHeader,
};
use crate::request::{InlineCheck, Operation, Range, VehicleInputs};
use crate::tracking::TrackingLibrary;

#[derive(Default)]
pub struct Session {
    library: TrackingLibrary,
    records: RecordShelf,
    records_key: String,
    records_offered: bool,
    decoded_since_bake: Duration,
    kept: Option<KeptBake>,
}

struct KeptBake {
    library: String,
    offered: Vec<String>,
    parts: KeptParts,
}

impl KeptBake {
    fn resumable(
        self,
        library: &str,
        offered: &[String],
        inputs: &BakeInputs,
    ) -> Option<KeptParts> {
        let serves = self.parts.serves(
            inputs.stud_primitives,
            inputs.unofficial_allowlist,
            &inputs.translucent,
            inputs.table_depth,
        );
        (self.library == library && self.offered == offered && serves).then_some(self.parts)
    }
}

struct BakeInputs<'a> {
    stud_primitives: &'a [String],
    unofficial_allowlist: &'a [String],
    translucent: HashSet<u32>,
    table_depth: f64,
    vehicles: Option<&'a VehicleInputs>,
    shard: CoverShard,
    visibility_only: bool,
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
        self.shelve_records(&request)?;
        match &request.envelope.request {
            Operation::ReadModel {
                omr_authoring_identification,
            } => read_model(
                &request.text("source")?,
                BakeOptions {
                    omr_authoring_identification: *omr_authoring_identification,
                },
                body,
            ),
            Operation::ReadStudio => Ok(match read_io(request.segment("io")?) {
                Ok(archive) => Reply::from(archive),
                Err(error) => Reply::from(error),
            }),
            Operation::Compile {
                lod,
                stud_primitives,
                unofficial_allowlist,
                connectors,
                parts,
                inline_checks,
                records,
            } => {
                if *records && Lod::from(*lod) != Lod::Standard {
                    return Err(BAKE_RECORD_LOD.to_string());
                }
                let rolling_mode = rolling_mode_from_studs(&self.library, stud_primitives);
                let stud_needs = self.library.take_requested();
                let options = CompileOptions {
                    lod: Lod::from(*lod),
                    stud_primitives: stud_primitives.clone(),
                    unofficial_allowlist: unofficial_allowlist.clone(),
                    technic: connectors.primitives.as_ref().map_or_else(
                        || Ok(TechnicPrimitives::default()),
                        TechnicPrimitives::from_table,
                    )?,
                    rolling_mode,
                };
                let inference = ConnectorInference::new(connectors)?;
                let model = request.text("source")?;
                compile(
                    &self.library,
                    &options,
                    CompileWork {
                        references: parts,
                        inline_checks,
                        stud_needs: &stud_needs,
                        inference: &inference,
                        records: *records,
                    },
                    &model,
                    body,
                )
            }
            Operation::BakeNeeds {
                stud_primitives,
                vehicles,
            } => {
                let drawn = drawn_instances(
                    &request.text("source")?,
                    request.segment("drawn")?,
                    BakeOptions::default(),
                )?;
                let closure = BakeClosure {
                    stud_primitives,
                    records: self.offered(),
                    vehicles: vehicles.as_ref(),
                };
                let paths = missing_bake_files(&self.library, &drawn, &closure);
                Ok(if paths.is_empty() {
                    Reply::Complete
                } else {
                    Reply::Need { paths }
                })
            }
            Operation::Bake {
                stud_primitives,
                unofficial_allowlist,
                translucent_colors,
                table_depth_ldu,
                vehicles,
                shard,
                keep_parts,
                omr_authoring_identification,
            } => {
                let drawn = drawn_instances(
                    &request.text("source")?,
                    request.segment("drawn")?,
                    BakeOptions {
                        omr_authoring_identification: *omr_authoring_identification,
                    },
                )?;
                let inputs = BakeInputs {
                    stud_primitives,
                    unofficial_allowlist,
                    translucent: translucent_colors.iter().copied().collect(),
                    table_depth: *table_depth_ldu,
                    vehicles: vehicles.as_ref(),
                    shard: shard.map_or(Ok(CoverShard::WHOLE), |shard| shard.cover())?,
                    visibility_only: shard.is_some_and(|shard| shard.visibility_only),
                };
                let decoded = std::mem::take(&mut self.decoded_since_bake);
                let offered = self.offered_references();
                let kept = self
                    .kept
                    .take()
                    .and_then(|kept| kept.resumable(self.library.key(), &offered, &inputs));
                let (reply, parts) = bake(
                    &self.library,
                    self.offered(),
                    &drawn,
                    &inputs,
                    decoded,
                    kept,
                    body,
                );
                if *keep_parts {
                    self.kept = parts.map(|parts| KeptBake {
                        library: self.library.key().to_string(),
                        offered,
                        parts,
                    });
                }
                Ok(reply)
            }
        }
    }

    fn offered_references(&self) -> Vec<String> {
        let mut references: Vec<String> = self.offered().keys().cloned().collect();
        references.sort_unstable();
        references
    }

    fn offered(&self) -> &RecordShelf {
        if self.records_offered {
            &self.records
        } else {
            &NO_RECORDS
        }
    }

    fn shelve_records(&mut self, request: &Request) -> Result<(), String> {
        let Some(records) = &request.envelope.records else {
            self.records_offered = false;
            return Ok(());
        };
        self.records_offered = true;
        if records.key != self.records_key {
            self.records.clear();
            self.records_key.clone_from(&records.key);
        }
        let decoding = Instant::now();
        for file in &records.files {
            let record = BakeRecord::decode(request.range(file.bytes)?)
                .map_err(|e| format!("bake record for {}: {e}", file.reference))?;
            self.records
                .insert(file.reference.clone(), Arc::new(record));
        }
        self.decoded_since_bake += decoding.elapsed();
        let offered: HashSet<&str> = records.references.iter().map(String::as_str).collect();
        self.records
            .retain(|reference, _| offered.contains(reference.as_str()));
        if let Some(missing) = records
            .references
            .iter()
            .find(|reference| !self.records.contains_key(*reference))
        {
            return Err(format!("the bake record for {missing} was never sent"));
        }
        Ok(())
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

fn wire_index(index: i64) -> Result<i32, String> {
    i32::try_from(index).map_err(|_| format!("sub-model index {index} does not fit an Int32"))
}

fn read_model(source: &str, options: BakeOptions, body: &mut Body) -> Result<Reply, String> {
    let model = bake_model_with(source, options).map_err(|e| e.to_string())?;
    let mut part_ids: Vec<String> = Vec::new();
    let mut part_index: HashMap<&str, u32> = HashMap::new();
    let count = model.instances.len();
    let mut parts = Vec::with_capacity(count);
    let mut colors = Vec::with_capacity(count);
    let mut transforms: Vec<f64> = Vec::with_capacity(count * 12);
    let mut holders = Vec::with_capacity(count);
    for instance in &model.instances {
        let key = instance.inline.as_deref().unwrap_or(&instance.part);
        let next = u32::try_from(part_ids.len()).map_err(|e| e.to_string())?;
        let index = *part_index.entry(key).or_insert_with(|| {
            part_ids.push(key.to_string());
            next
        });
        parts.push(index);
        colors.push(instance.color);
        transforms.extend(instance.matrix.m);
        holders.push(wire_index(submodel_index(instance.submodel))?);
    }
    let parents = model
        .submodel_parents()
        .into_iter()
        .map(wire_index)
        .collect::<Result<Vec<_>, _>>()?;
    body.blob("instancePart", &parts);
    body.blob("instanceColor", &colors);
    body.blob("instanceTransform", &transforms);
    body.blob("instanceSubmodel", &holders);
    body.blob("submodelParent", &parents);
    body.blob("submodelMatrix", &model.submodel_matrices());
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
        authored_identification: model
            .authored_identification
            .as_ref()
            .map(|authored| AuthoredIdentification::from(authored.columns(Some))),
        blobs: body.take_blobs(),
    })
}

struct CompileWork<'a> {
    references: &'a [String],
    inline_checks: &'a [InlineCheck],
    stud_needs: &'a [String],
    inference: &'a ConnectorInference<'a>,
    records: bool,
}

fn compiled_part(
    library: &TrackingLibrary,
    reference: &str,
    options: &CompileOptions,
    records: bool,
) -> Result<(CompiledPart, Option<BakeRecord>), CompileError> {
    let compiled = compile_part(library, reference, options)?;
    if !records {
        return Ok((compiled, None));
    }
    let bounds = part_bounds(library, reference)?;
    let record = BakeRecord::of(&compiled, bounds);
    Ok((compiled, Some(record)))
}

fn compile(
    library: &TrackingLibrary,
    options: &CompileOptions,
    work: CompileWork,
    model: &str,
    body: &mut Body,
) -> Result<Reply, String> {
    let CompileWork {
        references,
        inline_checks,
        stud_needs,
        inference,
        records,
    } = work;
    let mut parts = Vec::with_capacity(references.len());
    for reference in references {
        let result = compiled_part(library, reference, options, records);
        let mut requested = library.take_requested();
        requested.extend(stud_needs.iter().cloned());
        let connectors = match &result {
            Ok((compiled, _)) if requested.is_empty() && inference.wants(reference) => {
                let header = &compiled.flattened_files[0].header;
                let license = header.license.as_deref().unwrap_or_default();
                let record = inference.record(library, reference, &compiled.path, license);
                requested = library.take_requested();
                if requested.is_empty() {
                    Some(record?)
                } else {
                    None
                }
            }
            _ => None,
        };
        let reference = reference.clone();
        parts.push(match result {
            _ if !requested.is_empty() => PartOutcome::Need {
                reference,
                paths: requested,
            },
            Ok((compiled, record)) => PartOutcome::Compiled {
                glb: body.bytes(&compiled.to_glb()),
                record: match record {
                    Some(record) => {
                        Some(body.bytes(&record.encode().map_err(|e| format!("{reference}: {e}"))?))
                    }
                    None => None,
                },
                reference,
                file: compiled.path.clone(),
                header: Section::from(&compiled.flattened_files[0].header),
                files: compiled.flattened_files.len(),
                connectors,
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
                failure: Failure::from(&error),
            },
        });
    }
    Ok(Reply::Compiled {
        parts,
        inline,
        weld_epsilon_ldu: WELD_EPSILON_LDU,
    })
}

fn drawn_instances(
    source: &str,
    mask: &[u8],
    options: BakeOptions,
) -> Result<Vec<ModelInstance>, String> {
    let model = bake_model_with(source, options).map_err(|e| e.to_string())?;
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

struct BakeClosure<'a> {
    stud_primitives: &'a [String],
    records: &'a RecordShelf,
    vehicles: Option<&'a VehicleInputs>,
}

impl BakeClosure<'_> {
    fn reads_library(&self, reference: &str, signatures: &[&[String]]) -> bool {
        !self.records.contains_key(reference)
            || signatures
                .iter()
                .any(|names| names.iter().any(|name| name == reference))
    }
}

fn missing_bake_files(
    library: &TrackingLibrary,
    drawn: &[ModelInstance],
    closure: &BakeClosure,
) -> Vec<String> {
    let signatures = closure.vehicles.map(VehicleInputs::signatures);
    let analysed: Vec<&[String]> = signatures.as_ref().map_or_else(Vec::new, |s| {
        vec![
            s.wheelsets.as_slice(),
            s.bogie_pivots.as_slice(),
            s.couplers.as_slice(),
        ]
    });
    let mut scan = Flattener::new(library, Lod::Standard, &[]);
    let mut scanned: HashSet<&str> = HashSet::new();
    for reference in drawn
        .iter()
        .map(|instance| instance.part.as_str())
        .filter(|reference| closure.reads_library(reference, &analysed))
        .chain(closure.stud_primitives.iter().map(String::as_str))
    {
        if scanned.insert(reference) {
            scan.closure(reference);
        }
    }
    library.take_requested()
}

fn bake(
    library: &TrackingLibrary,
    records: &RecordShelf,
    drawn: &[ModelInstance],
    inputs: &BakeInputs,
    decoded: Duration,
    kept: Option<KeptParts>,
    body: &mut Body,
) -> (Reply, Option<KeptParts>) {
    let closure = BakeClosure {
        stud_primitives: inputs.stud_primitives,
        records,
        vehicles: inputs.vehicles,
    };
    let requested = missing_bake_files(library, drawn, &closure);
    if !requested.is_empty() {
        return (Reply::Need { paths: requested }, None);
    }
    let baked = bake_drawn(library, records, drawn, inputs, decoded, kept, body);
    let requested = library.take_requested();
    if !requested.is_empty() {
        return (Reply::Need { paths: requested }, None);
    }
    match baked {
        Ok((reply, parts)) => (reply, Some(parts)),
        Err(message) => (Reply::BakeFailed { message }, None),
    }
}

fn bake_drawn(
    library: &TrackingLibrary,
    records: &RecordShelf,
    drawn: &[ModelInstance],
    inputs: &BakeInputs,
    decoded: Duration,
    kept: Option<KeptParts>,
    body: &mut Body,
) -> Result<(Reply, KeptParts), String> {
    let mut phases = BakePhases {
        decode_ms: ms(decoded),
        ..BakePhases::default()
    };
    let resumed_parts = kept.as_ref().map_or(0, KeptParts::part_count);
    let baker = match kept {
        Some(parts) => ModelBaker::resume(library, parts),
        None => ModelBaker::new(
            library,
            inputs.stud_primitives.to_vec(),
            inputs.unofficial_allowlist.to_vec(),
            inputs.translucent.clone(),
            inputs.table_depth,
        )
        .map_err(|e| e.to_string())?,
    };
    let mut baker = baker.with_records(records);
    let mut shapes: HashMap<&str, LatticeShape> = HashMap::new();
    for instance in drawn {
        if !shapes.contains_key(instance.part.as_str()) {
            let resolving = Instant::now();
            let shape = baker
                .lattice_shape(&instance.part)
                .map_err(|e| format!("{}: {e}", instance.part))?;
            let resolved = ms(resolving.elapsed());
            if records.contains_key(&instance.part) {
                phases.decode_ms += resolved;
            } else {
                phases.compile_ms += resolved;
            }
            shapes.insert(&instance.part, shape);
        }
    }
    let drawn_shapes: Vec<&LatticeShape> = drawn
        .iter()
        .map(|instance| &shapes[instance.part.as_str()])
        .collect();
    if inputs.visibility_only {
        let covering = Instant::now();
        let cover = baker
            .cover(drawn, None, inputs.shard)
            .map_err(|e| e.to_string())?;
        phases.cover_ms = ms(covering.elapsed());
        put_cover(body, &cover)?;
        let reply = Reply::Baked {
            instances: drawn.len(),
            recorded_parts: baker.recorded_parts(),
            resumed_parts,
            lattice: None,
            lattice_issue: None,
            cover: Cover::from(&cover),
            vehicles: None,
            vehicle_issue: None,
            phases,
            blobs: body.take_blobs(),
        };
        return Ok((reply, baker.keep()));
    }
    let latticing = Instant::now();
    let (lattice, lattice_issue) = match drawn_lattice(drawn, &drawn_shapes) {
        Ok(lattice) => (lattice, None),
        Err(error) => (None, Some(error.to_string())),
    };
    phases.lattice_ms = ms(latticing.elapsed());
    let covering = Instant::now();
    let cover = baker
        .cover(drawn, lattice.as_ref(), inputs.shard)
        .map_err(|e| e.to_string())?;
    phases.cover_ms = ms(covering.elapsed());
    put_cover(body, &cover)?;
    let detecting = Instant::now();
    let (vehicles, vehicle_issue) = match inputs.vehicles {
        None => (None, None),
        Some(vehicles) => match baker.vehicles(drawn, &vehicles.signatures(), &vehicles.rails()?) {
            Ok(detected) => (Some(vehicle_headers(body, &detected)?), None),
            Err(error) => (None, Some(error.to_string())),
        },
    };
    phases.vehicles_ms = ms(detecting.elapsed());
    let reply = Reply::Baked {
        instances: drawn.len(),
        recorded_parts: baker.recorded_parts(),
        resumed_parts,
        lattice: lattice.as_ref().map(Lattice::from),
        lattice_issue,
        cover: Cover::from(&cover),
        vehicles,
        vehicle_issue,
        phases,
        blobs: body.take_blobs(),
    };
    Ok((reply, baker.keep()))
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

fn u32_indices(indices: &[usize]) -> Result<Vec<u32>, String> {
    indices
        .iter()
        .map(|&index| u32::try_from(index).map_err(|e| e.to_string()))
        .collect()
}

fn put_cover(body: &mut Body, cover: &ModelCover) -> Result<(), String> {
    if let Some(cells) = &cover.cells {
        body.blob("footprint", &u32_indices(&cells.footprint)?);
        body.blob("flat", &u32_indices(&cells.flat)?);
        body.blob("columnBottom", &plates(&cells.column_bottom)?);
        body.blob("columnTop", &plates(&cells.column_top)?);
        body.blob("footingInstance", &u32_indices(&cells.footing.instance)?);
        body.blob("footingCell", &u32_indices(&cells.footing.cell)?);
    }
    body.blob("visibleBits", &cover.visible_bits());
    Ok(())
}
