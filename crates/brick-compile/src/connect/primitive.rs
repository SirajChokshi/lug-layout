use std::collections::HashMap;
use std::rc::Rc;

use serde_json::Value;

use crate::affine::{Affine, Vec3};
use crate::flatten::{resolve_reference, Library, Lod};
use crate::ldraw::{self, Line};
use crate::pieces::{PieceMap, PieceNumbering};

use super::meta::{parse_metas, Meta};
use super::{
    column, finished, joined_pieces, length, translation, Caps, Connector, Gender, Issue, Scaling,
    Section, SectionShape, Shape, Source, Status, Traced,
};

const MAX_DEPTH: usize = 64;
const COAXIAL_LDU: f64 = 1e-3;
const OPPOSED_COSINE: f64 = 1e-6;
const CYLINDER_KIND: &str = "cyli";

#[derive(Clone, Copy, Debug, PartialEq)]
struct HoleEnd {
    counterbore_radius: f64,
    counterbore_length: f64,
    bore_radius: f64,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct PrimitiveTable {
    connectors: HashMap<String, Vec<Connector>>,
    where_open: HashMap<String, Vec<Connector>>,
    hole_ends: HashMap<String, HoleEnd>,
}

fn snap_list(entry: &Value, key: &str, file: &str) -> Result<Option<Vec<Connector>>, String> {
    let Some(snaps) = entry[key].as_array() else {
        return Ok(None);
    };
    let mut connectors = Vec::new();
    for snap in snaps {
        let line = snap
            .as_str()
            .ok_or(format!("{file}: {key} must be strings"))?;
        for parsed in parse_metas(&format!("0 !LDCAD {line}")) {
            match parsed.map_err(|e| format!("{file}: {e:?}"))?.meta {
                Meta::Snap(connector) => connectors.push(Connector {
                    source: Source::Primitive,
                    ..connector
                }),
                _ => return Err(format!("{file}: only snap descriptors are allowed")),
            }
        }
    }
    Ok(Some(connectors))
}

fn number(value: &Value, key: &str, entry: &str) -> Result<f64, String> {
    value[key]
        .as_f64()
        .ok_or(format!("{entry}: {key} must be a number"))
}

impl PrimitiveTable {
    pub fn from_json(value: &Value) -> Result<Self, String> {
        let mut table = PrimitiveTable::default();
        let entries = value["primitives"]
            .as_array()
            .ok_or("primitive table: primitives must be an array")?;
        for entry in entries {
            let file = entry["file"]
                .as_str()
                .ok_or("primitive table: every entry needs a file")?
                .to_string();
            if let Some(connectors) = snap_list(entry, "snaps", &file)? {
                table.connectors.insert(file.clone(), connectors);
            }
            if let Some(connectors) = snap_list(entry, "whereOpen", &file)? {
                table.where_open.insert(file.clone(), connectors);
            }
            let hole = &entry["holeEnd"];
            if hole.is_object() {
                table.hole_ends.insert(
                    file.clone(),
                    HoleEnd {
                        counterbore_radius: number(&hole["counterbore"], "radius", &file)?,
                        counterbore_length: number(&hole["counterbore"], "length", &file)?,
                        bore_radius: number(hole, "boreRadius", &file)?,
                    },
                );
            }
        }
        Ok(table)
    }
}

#[derive(Clone, Debug)]
struct PlacedEnd {
    primitive: String,
    end: HoleEnd,
    placement: Affine,
    trail: Vec<u32>,
}

#[derive(Default)]
struct Found {
    connectors: Vec<Traced>,
    where_open: Vec<Traced>,
    ends: Vec<PlacedEnd>,
    cylinders: Vec<Affine>,
}

fn is_cylinder_primitive(path: &str) -> bool {
    let Some(name) = path
        .strip_prefix("p/")
        .map(|rest| rest.rsplit('/').next().unwrap_or(rest))
    else {
        return false;
    };
    let Some((numerator, rest)) = name.split_once('-') else {
        return false;
    };
    let denominator: String = rest.chars().take_while(char::is_ascii_digit).collect();
    let kind = &rest[denominator.len()..];
    let suffix = kind
        .strip_prefix(CYLINDER_KIND)
        .and_then(|tail| tail.strip_suffix(".dat"));
    !numerator.is_empty()
        && numerator.chars().all(|c| c.is_ascii_digit())
        && !denominator.is_empty()
        && suffix.is_some_and(|digits| digits.chars().all(|c| c.is_ascii_digit()))
}

pub struct PrimitiveConnectors<'a, L: Library + ?Sized> {
    library: &'a L,
    table: PrimitiveTable,
    found: HashMap<String, Rc<Found>>,
    numbering: PieceNumbering<'a, L>,
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn unit(v: Vec3) -> Vec3 {
    let size = length(v);
    v.map(|c| c / size)
}

fn inward(end: &PlacedEnd) -> Vec3 {
    unit(column(&end.placement, 1))
}

fn through(a: &PlacedEnd, b: &PlacedEnd, pieces: &PieceMap) -> Connector {
    let along = inward(a);
    let scale_a = length(column(&a.placement, 1));
    let scale_b = length(column(&b.placement, 1));
    let start = translation(&a.placement);
    let end = translation(&b.placement);
    let span = dot(sub(end, start), along);
    let a_bore = a.end.counterbore_length * scale_a;
    let b_bore = b.end.counterbore_length * scale_b;
    let middle = [0, 1, 2].map(|k| (start[k] + end[k]) / 2.0);
    let x = unit(column(&a.placement, 0));
    let z = unit(column(&a.placement, 2));
    let placement = Affine::from_ldraw(
        middle,
        [
            x[0], -along[0], -z[0], x[1], -along[1], -z[1], x[2], -along[2], -z[2],
        ],
    );
    Connector {
        source: Source::Primitive,
        status: Status::Verified,
        id: None,
        group: None,
        shape: Shape::Cylinder {
            gender: Gender::Female,
            sections: vec![
                Section {
                    shape: SectionShape::Round,
                    radius: a.end.counterbore_radius,
                    length: a_bore,
                },
                Section {
                    shape: SectionShape::Round,
                    radius: a.end.bore_radius,
                    length: span - a_bore - b_bore,
                },
                Section {
                    shape: SectionShape::Round,
                    radius: b.end.counterbore_radius,
                    length: b_bore,
                },
            ],
            caps: Caps::None,
            center: true,
            slide: true,
            scaling: Scaling::Fixed,
        },
        placement,
        grid: None,
        pieces: joined_pieces(&[pieces.piece(&a.trail)], &[pieces.piece(&b.trail)]),
    }
}

fn bore_is_drawn(a: &PlacedEnd, b: &PlacedEnd, cylinders: &[Affine]) -> bool {
    let along = inward(a);
    let start = translation(&a.placement);
    let span = dot(sub(translation(&b.placement), start), along);
    let from = a.end.counterbore_length * length(column(&a.placement, 1));
    let to = span - b.end.counterbore_length * length(column(&b.placement, 1));
    let bore = a.end.bore_radius * length(column(&a.placement, 0));
    let mut pieces: Vec<(f64, f64)> = cylinders
        .iter()
        .filter_map(|m| {
            let axis = column(m, 1);
            let size = length(axis);
            if size == 0.0
                || dot(axis, along).abs() < size * (1.0 - OPPOSED_COSINE)
                || (length(column(m, 0)) - bore).abs() > COAXIAL_LDU
            {
                return None;
            }
            let offset = sub(translation(m), start);
            let near = dot(offset, along);
            if length(sub(offset, along.map(|c| c * near))) > COAXIAL_LDU {
                return None;
            }
            let far = near + dot(axis, along);
            Some((near.min(far), near.max(far)))
        })
        .collect();
    pieces.sort_by(|p, q| p.0.total_cmp(&q.0));
    let mut covered = from;
    for (low, high) in pieces {
        if low > covered + COAXIAL_LDU {
            break;
        }
        covered = covered.max(high);
    }
    covered >= to - COAXIAL_LDU
}

fn paired(
    ends: &[PlacedEnd],
    cylinders: &[Affine],
    pieces: &PieceMap,
    issues: &mut Vec<Issue>,
) -> Vec<Connector> {
    let mut used = vec![false; ends.len()];
    let mut out = Vec::new();
    for (i, a) in ends.iter().enumerate() {
        if used[i] {
            continue;
        }
        let along = inward(a);
        let start = translation(&a.placement);
        let partner = ends
            .iter()
            .enumerate()
            .filter(|(j, b)| {
                let offset = sub(translation(&b.placement), start);
                let depth = dot(offset, along);
                let off_axis = length(sub(offset, along.map(|c| c * depth)));
                *j != i
                    && !used[*j]
                    && dot(inward(b), along) <= -1.0 + OPPOSED_COSINE
                    && depth > a.end.counterbore_length + b.end.counterbore_length
                    && off_axis <= COAXIAL_LDU
            })
            .min_by(|(_, p), (_, q)| {
                let d = |e: &PlacedEnd| dot(sub(translation(&e.placement), start), along);
                d(p).total_cmp(&d(q))
            })
            .map(|(j, _)| j);
        match partner {
            Some(j) => {
                used[i] = true;
                used[j] = true;
                if bore_is_drawn(a, &ends[j], cylinders) {
                    out.push(through(a, &ends[j], pieces));
                } else {
                    issues.push(Issue::UndrawnHoleInterior {
                        primitive: a.primitive.clone(),
                        origin: start,
                    });
                }
            }
            None => issues.push(Issue::UnpairedHoleEnd {
                primitive: a.primitive.clone(),
                origin: start,
            }),
        }
    }
    out
}

impl<'a, L: Library + ?Sized> PrimitiveConnectors<'a, L> {
    pub fn new(library: &'a L, table: PrimitiveTable) -> Self {
        PrimitiveConnectors {
            library,
            table,
            found: HashMap::new(),
            numbering: PieceNumbering::new(library),
        }
    }

    pub fn connectors(&mut self, path: &str) -> (Vec<Connector>, Vec<Issue>) {
        let found = self.find(path, 0);
        let pieces = self.numbering.map(path);
        let mut issues = Vec::new();
        let mut raw: Vec<Connector> = found
            .connectors
            .iter()
            .map(|traced| Connector {
                pieces: vec![pieces.piece(&traced.trail)],
                ..traced.connector.clone()
            })
            .collect();
        raw.extend(paired(&found.ends, &found.cylinders, &pieces, &mut issues));
        let connectors = raw
            .iter()
            .map(|connector| finished(connector, &mut issues))
            .collect();
        (connectors, issues)
    }

    pub fn where_open(&mut self, path: &str) -> Vec<Connector> {
        let found = self.find(path, 0);
        let pieces = self.numbering.map(path);
        let mut ignored = Vec::new();
        found
            .where_open
            .iter()
            .map(|traced| Connector {
                pieces: vec![pieces.piece(&traced.trail)],
                ..finished(&traced.connector, &mut ignored)
            })
            .flat_map(|connector| {
                let offsets = connector
                    .grid
                    .map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets());
                offsets.into_iter().map(move |offset| {
                    let at = connector.placement.apply(offset);
                    let mut m = connector.placement.m;
                    m[3] = at[0] + 0.0;
                    m[7] = at[1] + 0.0;
                    m[11] = at[2] + 0.0;
                    Connector {
                        placement: Affine { m },
                        grid: None,
                        ..connector.clone()
                    }
                })
            })
            .collect()
    }

    fn find(&mut self, path: &str, depth: usize) -> Rc<Found> {
        if let Some(found) = self.found.get(path) {
            return Rc::clone(found);
        }
        let mut out = Found::default();
        if depth <= MAX_DEPTH {
            if let Some(source) = self.library.source(path) {
                let subfiles =
                    ldraw::parse(source)
                        .lines
                        .into_iter()
                        .filter_map(|line| match line {
                            Line::Subfile {
                                matrix, reference, ..
                            } => Some((matrix, reference)),
                            _ => None,
                        });
                for (ordinal, (matrix, reference)) in (0u32..).zip(subfiles) {
                    let Some(child) = resolve_reference(self.library, Lod::Standard, &reference)
                    else {
                        continue;
                    };
                    let template =
                        |c: &Connector| Traced::declared(c.clone()).through(ordinal, &matrix);
                    if let Some(templates) = self.table.connectors.get(&child) {
                        out.connectors.extend(templates.iter().map(template));
                        continue;
                    }
                    if let Some(templates) = self.table.where_open.get(&child) {
                        out.where_open.extend(templates.iter().map(template));
                    }
                    if is_cylinder_primitive(&child) {
                        out.cylinders.push(matrix);
                        continue;
                    }
                    if let Some(end) = self.table.hole_ends.get(&child) {
                        out.ends.push(PlacedEnd {
                            primitive: child.clone(),
                            end: *end,
                            placement: matrix,
                            trail: vec![ordinal],
                        });
                        continue;
                    }
                    let inner = self.find(&child, depth + 1);
                    out.connectors
                        .extend(inner.connectors.iter().map(|c| c.through(ordinal, &matrix)));
                    out.where_open
                        .extend(inner.where_open.iter().map(|c| c.through(ordinal, &matrix)));
                    out.ends.extend(inner.ends.iter().map(|e| {
                        PlacedEnd {
                            placement: matrix.then(&e.placement),
                            trail: std::iter::once(ordinal)
                                .chain(e.trail.iter().copied())
                                .collect(),
                            ..e.clone()
                        }
                    }));
                    out.cylinders
                        .extend(inner.cylinders.iter().map(|c| matrix.then(c)));
                }
            }
        }
        let found = Rc::new(out);
        self.found.insert(path.to_string(), Rc::clone(&found));
        found
    }
}
