use std::cmp::Ordering;
use std::collections::HashMap;
use std::rc::Rc;

use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::exact::{Decimal, Exact, ExactAffine};
use crate::flatten::{resolve_reference, FlattenError, Library, Lod};
use crate::ldraw::normalize_reference;

const MAX_DEPTH: usize = 64;
const CANDIDATE_MARGIN_LDU: f64 = 1e-6;
const MATRIX_NUMBERS: usize = 12;
const TRIANGLE_NUMBERS: usize = 9;
const QUAD_NUMBERS: usize = 12;
const AXES: usize = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct PartExtents {
    pub min: [Exact; AXES],
    pub max: [Exact; AXES],
}

impl PartExtents {
    pub fn to_json(&self) -> Value {
        let text = |value: &Exact| {
            let (numerator, denominator) = value.reduced_fraction();
            json!({ "numerator": numerator.to_string(), "denominator": denominator.to_string() })
        };
        json!({
            "min": self.min.iter().map(text).collect::<Vec<_>>(),
            "max": self.max.iter().map(text).collect::<Vec<_>>(),
        })
    }
}

enum Geometry {
    Subfile {
        matrix: Affine,
        numbers: Box<[Decimal; MATRIX_NUMBERS]>,
        reference: String,
    },
    Points {
        points: Vec<Vec3>,
        numbers: Vec<[Decimal; AXES]>,
    },
}

struct ExtentFile {
    lines: Vec<Geometry>,
}

fn decimal_tokens(tokens: &[&str], count: usize) -> Option<(Vec<f64>, Vec<Decimal>)> {
    let tokens = tokens.get(..count)?;
    let mut values = Vec::with_capacity(count);
    let mut decimals = Vec::with_capacity(count);
    for token in tokens {
        let value: f64 = token.parse().ok()?;
        if !value.is_finite() {
            return None;
        }
        values.push(value);
        decimals.push(Decimal::parse(token)?);
    }
    Some((values, decimals))
}

fn points_line(rest: &[&str], count: usize) -> Option<Geometry> {
    let (values, decimals) = decimal_tokens(rest.get(1..)?, count)?;
    Some(Geometry::Points {
        points: values.chunks(AXES).map(|p| [p[0], p[1], p[2]]).collect(),
        numbers: decimals
            .chunks(AXES)
            .map(|p| [p[0].clone(), p[1].clone(), p[2].clone()])
            .collect(),
    })
}

fn subfile_line(rest: &[&str]) -> Option<Geometry> {
    let (values, decimals) = decimal_tokens(rest.get(1..)?, MATRIX_NUMBERS)?;
    let numbers: Box<[Decimal; MATRIX_NUMBERS]> = Box::new(decimals.try_into().ok()?);
    let reference = rest.get(1 + MATRIX_NUMBERS..)?.join(" ");
    if reference.is_empty() {
        return None;
    }
    let mut rotation = [0.0; 9];
    rotation.copy_from_slice(&values[AXES..]);
    Some(Geometry::Subfile {
        matrix: Affine::from_ldraw([values[0], values[1], values[2]], rotation),
        numbers,
        reference: normalize_reference(&reference),
    })
}

fn parse(source: &str) -> ExtentFile {
    let mut lines = Vec::new();
    let mut first = true;
    for raw in source.lines() {
        let tokens: Vec<&str> = raw.split_whitespace().collect();
        let Some((kind, rest)) = tokens.split_first() else {
            continue;
        };
        if first && *kind == "0" {
            first = false;
            continue;
        }
        first = false;
        let line = match *kind {
            "1" => subfile_line(rest),
            "3" => points_line(rest, TRIANGLE_NUMBERS),
            "4" => points_line(rest, QUAD_NUMBERS),
            _ => None,
        };
        lines.extend(line);
    }
    ExtentFile { lines }
}

type Bounds = [Vec3; 2];

fn grow(bounds: &mut Option<Bounds>, point: Vec3) {
    match bounds {
        Some([low, high]) => {
            for axis in 0..AXES {
                low[axis] = low[axis].min(point[axis]);
                high[axis] = high[axis].max(point[axis]);
            }
        }
        None => *bounds = Some([point, point]),
    }
}

fn placed_box(matrix: &Affine, [low, high]: &Bounds) -> Bounds {
    let centre: Vec3 = std::array::from_fn(|axis| (low[axis] + high[axis]) / 2.0);
    let half: Vec3 = std::array::from_fn(|axis| (high[axis] - low[axis]) / 2.0);
    let moved = matrix.apply(centre);
    let reach: Vec3 = std::array::from_fn(|row| {
        (0..AXES)
            .map(|k| matrix.m[row * 4 + k].abs() * half[k])
            .sum()
    });
    [
        std::array::from_fn(|axis| moved[axis] - reach[axis]),
        std::array::from_fn(|axis| moved[axis] + reach[axis]),
    ]
}

struct Zone {
    low: Vec3,
    high: Vec3,
}

impl Zone {
    fn near_low(&self, axis: usize, value: f64, margin: f64) -> bool {
        value <= self.low[axis] + margin
    }

    fn near_high(&self, axis: usize, value: f64, margin: f64) -> bool {
        value >= self.high[axis] - margin
    }

    fn reaches(&self, [low, high]: &Bounds) -> bool {
        let margin = 2.0 * CANDIDATE_MARGIN_LDU;
        (0..AXES).any(|axis| {
            self.near_low(axis, low[axis], margin) || self.near_high(axis, high[axis], margin)
        })
    }
}

#[derive(Default)]
struct Extremes {
    low: [Option<Exact>; AXES],
    high: [Option<Exact>; AXES],
}

impl Extremes {
    fn offer(slot: &mut Option<Exact>, value: &Exact, wanted: Ordering) {
        if slot
            .as_ref()
            .is_none_or(|known| value.compare(known) == wanted)
        {
            *slot = Some(value.clone());
        }
    }
}

struct Walker<'a, L: Library> {
    library: &'a L,
    files: HashMap<String, Rc<ExtentFile>>,
    boxes: HashMap<String, Option<Bounds>>,
    unresolved: Option<FlattenError>,
}

impl<'a, L: Library> Walker<'a, L> {
    fn file(&mut self, path: &str) -> Option<Rc<ExtentFile>> {
        if let Some(file) = self.files.get(path) {
            return Some(Rc::clone(file));
        }
        let file = Rc::new(parse(self.library.source(path)?));
        self.files.insert(path.to_string(), Rc::clone(&file));
        Some(file)
    }

    fn child(&mut self, reference: &str, from: &str) -> Option<(String, Rc<ExtentFile>)> {
        let resolved = resolve_reference(self.library, Lod::Standard, reference)
            .and_then(|path| self.file(&path).map(|file| (path, file)));
        if resolved.is_none() {
            self.unresolved
                .get_or_insert_with(|| FlattenError::Unresolved {
                    reference: reference.to_string(),
                    from: from.to_string(),
                });
        }
        resolved
    }

    fn scan(
        &mut self,
        path: &str,
        file: &ExtentFile,
        matrix: &Affine,
        depth: usize,
        bounds: &mut Option<Bounds>,
    ) -> Result<(), FlattenError> {
        if depth > MAX_DEPTH {
            return Err(FlattenError::TooDeep {
                path: path.to_string(),
            });
        }
        for line in &file.lines {
            match line {
                Geometry::Points { points, .. } => {
                    for point in points {
                        grow(bounds, matrix.apply(*point));
                    }
                }
                Geometry::Subfile {
                    matrix: placement,
                    reference,
                    ..
                } => {
                    let Some((child_path, child)) = self.child(reference, path) else {
                        continue;
                    };
                    self.scan(
                        &child_path,
                        &child,
                        &matrix.then(placement),
                        depth + 1,
                        bounds,
                    )?;
                }
            }
        }
        Ok(())
    }

    fn local_box(&mut self, path: &str, file: &ExtentFile) -> Option<Bounds> {
        if let Some(known) = self.boxes.get(path) {
            return *known;
        }
        let mut bounds = None;
        for line in &file.lines {
            match line {
                Geometry::Points { points, .. } => {
                    for point in points {
                        grow(&mut bounds, *point);
                    }
                }
                Geometry::Subfile {
                    matrix, reference, ..
                } => {
                    let Some((child_path, child)) = self.child(reference, path) else {
                        continue;
                    };
                    if let Some(inner) = self.local_box(&child_path, &child) {
                        let [low, high] = placed_box(matrix, &inner);
                        grow(&mut bounds, low);
                        grow(&mut bounds, high);
                    }
                }
            }
        }
        self.boxes.insert(path.to_string(), bounds);
        bounds
    }

    fn refine(
        &mut self,
        path: &str,
        file: &ExtentFile,
        frame: (&Affine, &ExactAffine),
        zone: &Zone,
        extremes: &mut Extremes,
    ) {
        let (matrix, exact) = frame;
        for line in &file.lines {
            match line {
                Geometry::Points { points, numbers } => {
                    for (point, decimals) in points.iter().zip(numbers) {
                        let placed = matrix.apply(*point);
                        let low: [bool; AXES] = std::array::from_fn(|axis| {
                            zone.near_low(axis, placed[axis], CANDIDATE_MARGIN_LDU)
                        });
                        let high: [bool; AXES] = std::array::from_fn(|axis| {
                            zone.near_high(axis, placed[axis], CANDIDATE_MARGIN_LDU)
                        });
                        if !low.iter().chain(&high).any(|&near| near) {
                            continue;
                        }
                        let value = exact.apply(decimals);
                        for axis in 0..AXES {
                            if low[axis] {
                                Extremes::offer(
                                    &mut extremes.low[axis],
                                    &value[axis],
                                    Ordering::Less,
                                );
                            }
                            if high[axis] {
                                Extremes::offer(
                                    &mut extremes.high[axis],
                                    &value[axis],
                                    Ordering::Greater,
                                );
                            }
                        }
                    }
                }
                Geometry::Subfile {
                    matrix: placement,
                    numbers,
                    reference,
                } => {
                    let Some((child_path, child)) = self.child(reference, path) else {
                        continue;
                    };
                    let placed = matrix.then(placement);
                    let reaches = self
                        .local_box(&child_path, &child)
                        .is_some_and(|inner| zone.reaches(&placed_box(&placed, &inner)));
                    if reaches {
                        let exact_child = exact.then(&ExactAffine::from_ldraw(numbers));
                        self.refine(&child_path, &child, (&placed, &exact_child), zone, extremes);
                    }
                }
            }
        }
    }
}

pub fn part_extents<L: Library>(
    library: &L,
    path: &str,
) -> Result<Option<PartExtents>, FlattenError> {
    let mut walker = Walker {
        library,
        files: HashMap::new(),
        boxes: HashMap::new(),
        unresolved: None,
    };
    let file = walker.file(path).ok_or_else(|| FlattenError::Unresolved {
        reference: path.to_string(),
        from: String::new(),
    })?;
    let mut bounds = None;
    walker.scan(path, &file, &Affine::IDENTITY, 0, &mut bounds)?;
    if let Some(error) = walker.unresolved.take() {
        return Err(error);
    }
    let Some([low, high]) = bounds else {
        return Ok(None);
    };
    let zone = Zone { low, high };
    let mut extremes = Extremes::default();
    walker.refine(
        path,
        &file,
        (&Affine::IDENTITY, &ExactAffine::identity()),
        &zone,
        &mut extremes,
    );
    let take = |slot: &Option<Exact>| slot.clone().unwrap_or_else(Exact::zero);
    let [low_x, low_y, low_z] = extremes.low.each_ref().map(take);
    let [high_x, high_y, high_z] = extremes.high.each_ref().map(take);
    Ok(Some(PartExtents {
        min: [low_x, high_y.neg(), high_z.neg()],
        max: [high_x, low_y.neg(), low_z.neg()],
    }))
}
