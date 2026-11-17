use std::collections::{HashMap, HashSet};
use std::thread;

use crate::affine::{Affine, Vec3};
use crate::cover::{inverse, PartSolid};
use crate::lattice::STUD_LDU;

pub const SAMPLES_PER_STUD: usize = 10;
pub const STEPS_PER_LDU: f64 = 16.0;
pub const SAMPLES_PER_CELL: usize = SAMPLES_PER_STUD * SAMPLES_PER_STUD;
const SAMPLE_PITCH_LDU: f64 = STUD_LDU / SAMPLES_PER_STUD as f64;
const REPRESENTATION_EPSILON_LDU: f64 = 1e-6;
const COVERAGE_TOLERANCE: f64 = 1e-9;
const FLAT_AREA_LDU2: f64 = 1e-9;
const DISTINCT_HIT_LDU: f64 = 1e-9;
const PROBE_KEY_SCALE: f64 = 1_000.0;
const EMPTY_LIST: u32 = 0;
const LOCAL_AXES: [Vec3; 6] = [
    [1.0, 0.0, 0.0],
    [-1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, -1.0, 0.0],
    [0.0, 0.0, 1.0],
    [0.0, 0.0, -1.0],
];

#[derive(Clone, Copy)]
pub struct SolidInstance<'a> {
    pub matrix: &'a Affine,
    pub part: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SolidGrid {
    pub origin: [f64; 2],
    pub width: usize,
    pub depth: usize,
    pub datum_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SolidSamples {
    pub lists: Vec<i32>,
    pub patterns: Vec<u32>,
    pub cells: Vec<i32>,
    pub overlaps: Vec<[usize; 2]>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoarseSpans {
    pub start: Vec<u32>,
    pub spans: Vec<i32>,
}

impl SolidSamples {
    pub fn coarse_spans(&self) -> CoarseSpans {
        let steps = STEPS_PER_LDU as i32;
        let mut start = vec![0];
        let mut spans: Vec<i32> = Vec::new();
        for pattern in self.patterns.chunks(SAMPLES_PER_CELL) {
            let mut ends: Vec<(i32, i32)> = Vec::new();
            for &offset in pattern {
                let offset = offset as usize;
                let count = self.lists[offset] as usize;
                for pair in self.lists[offset + 1..offset + 1 + 2 * count].chunks(2) {
                    ends.push((pair[0].div_euclid(steps), -(-pair[1]).div_euclid(steps)));
                }
            }
            ends.sort_unstable();
            let first = spans.len();
            for (bottom, top) in ends {
                match spans[first..].last_mut() {
                    Some(last) if bottom <= *last => *last = (*last).max(top),
                    _ => spans.extend([bottom, top]),
                }
            }
            start.push(spans.len() as u32);
        }
        CoarseSpans { start, spans }
    }

    pub fn sample_bytes(&self) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(4 * (self.lists.len() + self.patterns.len()));
        for value in &self.lists {
            bytes.extend_from_slice(&value.to_le_bytes());
        }
        for &value in &self.patterns {
            bytes.extend_from_slice(&(value as i32).to_le_bytes());
        }
        bytes
    }
}

#[derive(Clone, Copy)]
struct Span {
    sample: u32,
    bottom: i32,
    top: i32,
    instance: u32,
}

fn steps_up(y: f64) -> i32 {
    let steps = y * STEPS_PER_LDU;
    let nearest = steps.round();
    let value = if (steps - nearest).abs() <= REPRESENTATION_EPSILON_LDU * STEPS_PER_LDU {
        nearest
    } else {
        steps.ceil()
    };
    value as i32
}

fn steps_down(y: f64) -> i32 {
    let steps = y * STEPS_PER_LDU;
    let nearest = steps.round();
    let value = if (steps - nearest).abs() <= REPRESENTATION_EPSILON_LDU * STEPS_PER_LDU {
        nearest
    } else {
        steps.floor()
    };
    value as i32
}

fn sample_centre(origin: f64, index: usize) -> f64 {
    origin + SAMPLE_PITCH_LDU * (index as f64 + 0.5)
}

fn sample_range(lo: f64, hi: f64, origin: f64, count: usize) -> Option<(usize, usize)> {
    let first = ((lo - origin) / SAMPLE_PITCH_LDU - 0.5).ceil().max(0.0);
    let last = ((hi - origin) / SAMPLE_PITCH_LDU - 0.5).floor();
    if last < first || first >= count as f64 || last < 0.0 {
        return None;
    }
    Some((first as usize, (last as usize).min(count - 1)))
}

struct Sampler<'a> {
    solids: &'a [PartSolid],
    grid: SolidGrid,
    columns: usize,
    rows: usize,
    enclosed: HashMap<(usize, i64, i64, i64), bool>,
}

impl Sampler<'_> {
    fn enclosed(&mut self, part: usize, local: Vec3) -> bool {
        let key = (
            part,
            (local[0] * PROBE_KEY_SCALE).round() as i64,
            (local[1] * PROBE_KEY_SCALE).round() as i64,
            (local[2] * PROBE_KEY_SCALE).round() as i64,
        );
        if let Some(&known) = self.enclosed.get(&key) {
            return known;
        }
        let solid = &self.solids[part];
        let inside = LOCAL_AXES
            .iter()
            .all(|direction| solid.blocks(local, *direction));
        self.enclosed.insert(key, inside);
        inside
    }

    fn instance_spans(&mut self, index: usize, instance: SolidInstance, out: &mut Vec<Span>) {
        let solid = &self.solids[instance.part];
        let Some(local_of) = inverse(instance.matrix) else {
            return;
        };
        let world: Vec<[Vec3; 3]> = solid
            .triangles()
            .iter()
            .map(|t| t.map(|p| instance.matrix.apply(p)))
            .collect();
        if world.is_empty() {
            return;
        }
        let (mut min_x, mut max_x, mut min_z, mut max_z) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for p in world.iter().flatten() {
            min_x = min_x.min(p[0]);
            max_x = max_x.max(p[0]);
            min_z = min_z.min(p[2]);
            max_z = max_z.max(p[2]);
        }
        let grid = self.grid;
        let Some((u0, u1)) = sample_range(min_x, max_x, grid.origin[0], self.columns) else {
            return;
        };
        let Some((v0, v1)) = sample_range(min_z, max_z, grid.origin[1], self.rows) else {
            return;
        };
        let span_u = u1 - u0 + 1;
        let mut hits: Vec<Vec<f64>> = vec![Vec::new(); span_u * (v1 - v0 + 1)];
        for [a, b, c] in &world {
            let area = (b[0] - a[0]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[0] - a[0]);
            if area.abs() < FLAT_AREA_LDU2 {
                continue;
            }
            let lo_x = a[0].min(b[0]).min(c[0]);
            let hi_x = a[0].max(b[0]).max(c[0]);
            let lo_z = a[2].min(b[2]).min(c[2]);
            let hi_z = a[2].max(b[2]).max(c[2]);
            let Some((tu0, tu1)) = sample_range(lo_x, hi_x, grid.origin[0], self.columns) else {
                continue;
            };
            let Some((tv0, tv1)) = sample_range(lo_z, hi_z, grid.origin[1], self.rows) else {
                continue;
            };
            for v in tv0..=tv1 {
                let z = sample_centre(grid.origin[1], v);
                for u in tu0..=tu1 {
                    let x = sample_centre(grid.origin[0], u);
                    let wa = ((b[0] - x) * (c[2] - z) - (b[2] - z) * (c[0] - x)) / area;
                    let wb = ((c[0] - x) * (a[2] - z) - (c[2] - z) * (a[0] - x)) / area;
                    let wc = 1.0 - wa - wb;
                    if wa < -COVERAGE_TOLERANCE
                        || wb < -COVERAGE_TOLERANCE
                        || wc < -COVERAGE_TOLERANCE
                    {
                        continue;
                    }
                    let y = wa * a[1] + wb * b[1] + wc * c[1];
                    hits[(v - v0) * span_u + (u - u0)].push(y);
                }
            }
        }
        for (slot, ys) in hits.iter_mut().enumerate() {
            if ys.len() < 2 {
                continue;
            }
            ys.sort_by(f64::total_cmp);
            ys.dedup_by(|b, a| (*b - *a).abs() <= DISTINCT_HIT_LDU);
            let u = u0 + slot % span_u;
            let v = v0 + slot / span_u;
            let x = sample_centre(grid.origin[0], u);
            let z = sample_centre(grid.origin[1], v);
            let sample = (v * self.columns + u) as u32;
            let mut open: Option<(f64, f64)> = None;
            for pair in ys.windows(2) {
                let middle = [x, (pair[0] + pair[1]) / 2.0, z];
                if self.enclosed(instance.part, local_of.apply(middle)) {
                    open = Some(match open {
                        Some((bottom, _)) => (bottom, pair[1]),
                        None => (pair[0], pair[1]),
                    });
                } else if let Some((bottom, top)) = open.take() {
                    push_span(out, sample, index, bottom, top, grid.datum_y);
                }
            }
            if let Some((bottom, top)) = open {
                push_span(out, sample, index, bottom, top, grid.datum_y);
            }
        }
    }
}

fn push_span(out: &mut Vec<Span>, sample: u32, instance: usize, bottom: f64, top: f64, datum: f64) {
    let bottom = steps_up(bottom - datum);
    let top = steps_down(top - datum);
    if top > bottom {
        out.push(Span {
            sample,
            bottom,
            top,
            instance: instance as u32,
        });
    }
}

fn sampled_spans(instances: &[SolidInstance], solids: &[PartSolid], grid: SolidGrid) -> Vec<Span> {
    if instances.is_empty() {
        return Vec::new();
    }
    let workers = thread::available_parallelism().map_or(1, |n| n.get());
    let chunk = instances.len().div_ceil(workers);
    let mut spans = Vec::new();
    thread::scope(|scope| {
        let handles: Vec<_> = instances
            .chunks(chunk)
            .enumerate()
            .map(|(c, slice)| {
                scope.spawn(move || {
                    let mut sampler = Sampler {
                        solids,
                        grid,
                        columns: grid.width * SAMPLES_PER_STUD,
                        rows: grid.depth * SAMPLES_PER_STUD,
                        enclosed: HashMap::new(),
                    };
                    let mut out = Vec::new();
                    for (k, instance) in slice.iter().enumerate() {
                        sampler.instance_spans(c * chunk + k, *instance, &mut out);
                    }
                    out
                })
            })
            .collect();
        for handle in handles {
            spans.extend(handle.join().unwrap_or_default());
        }
    });
    spans
}

pub fn solid_samples(
    instances: &[SolidInstance],
    solids: &[PartSolid],
    grid: SolidGrid,
) -> SolidSamples {
    let mut spans = sampled_spans(instances, solids, grid);
    spans.sort_by_key(|s| (s.sample, s.bottom, s.top, s.instance));
    let columns = grid.width * SAMPLES_PER_STUD;
    let mut lists = vec![0];
    let mut list_index: HashMap<Vec<i32>, u32> = HashMap::from([(vec![0], EMPTY_LIST)]);
    let mut sample_lists = vec![EMPTY_LIST; columns * grid.depth * SAMPLES_PER_STUD];
    let mut overlaps: HashSet<[usize; 2]> = HashSet::new();
    let mut active: Vec<Span> = Vec::new();
    let mut union: Vec<i32> = Vec::new();
    for group in spans.chunk_by(|a, b| a.sample == b.sample) {
        active.clear();
        union.clear();
        for span in group {
            active.retain(|a| a.top > span.bottom);
            for a in &active {
                if a.instance != span.instance {
                    let pair = [a.instance.min(span.instance), a.instance.max(span.instance)];
                    overlaps.insert(pair.map(|i| i as usize));
                }
            }
            active.push(*span);
            match union.last_mut() {
                Some(top) if span.bottom <= *top => *top = (*top).max(span.top),
                _ => union.extend([span.bottom, span.top]),
            }
        }
        let mut list = Vec::with_capacity(union.len() + 1);
        list.push((union.len() / 2) as i32);
        list.extend_from_slice(&union);
        let offset = *list_index.entry(list).or_insert_with_key(|list| {
            let offset = lists.len() as u32;
            lists.extend_from_slice(list);
            offset
        });
        sample_lists[group[0].sample as usize] = offset;
    }
    let mut patterns = Vec::new();
    let mut pattern_index: HashMap<Vec<u32>, i32> = HashMap::new();
    let mut cells = vec![-1; grid.width * grid.depth];
    for j in 0..grid.depth {
        for i in 0..grid.width {
            let pattern: Vec<u32> = (0..SAMPLES_PER_CELL)
                .map(|s| {
                    let u = i * SAMPLES_PER_STUD + s % SAMPLES_PER_STUD;
                    let v = j * SAMPLES_PER_STUD + s / SAMPLES_PER_STUD;
                    sample_lists[v * columns + u]
                })
                .collect();
            if pattern.iter().all(|&offset| offset == EMPTY_LIST) {
                continue;
            }
            let count = pattern_index.len() as i32;
            cells[j * grid.width + i] = *pattern_index.entry(pattern).or_insert_with_key(|p| {
                patterns.extend_from_slice(p);
                count
            });
        }
    }
    let mut overlaps: Vec<[usize; 2]> = overlaps.into_iter().collect();
    overlaps.sort_unstable();
    SolidSamples {
        lists,
        patterns,
        cells,
        overlaps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coarse_spans_union_every_sample_of_a_pattern_rounded_out_to_whole_ldu() {
        let mut patterns = vec![1; SAMPLES_PER_CELL];
        patterns[7] = 4;
        let samples = SolidSamples {
            lists: vec![0, 1, -64, 0, 2, 1, 40, 200, 300],
            patterns,
            cells: vec![0],
            overlaps: Vec::new(),
        };
        assert_eq!(
            samples.coarse_spans(),
            CoarseSpans {
                start: vec![0, 4],
                spans: vec![-4, 3, 12, 19],
            }
        );
        assert_eq!(samples.sample_bytes()[..8], [0, 0, 0, 0, 1, 0, 0, 0]);
    }
}
