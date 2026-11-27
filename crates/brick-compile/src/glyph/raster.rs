use std::collections::{BTreeSet, HashSet};

use super::outline::{trace, SampleMask};
use super::{
    resolve_color, Glyph, GlyphError, MAX_COLORS, MAX_PIXELS, MAX_SIDE_PIXELS, PIXELS_PER_STUD,
    SAMPLES_PER_PIXEL_SIDE,
};
use crate::affine::Affine;
use crate::identify::SIXTEENTHS_PER_LDU;
use crate::lattice::STUD_LDU;
use crate::mesh::Mesh;

const STUD_SIXTEENTHS: i64 = STUD_LDU as i64 * SIXTEENTHS_PER_LDU as i64;
const PIXEL_SIXTEENTHS: i64 = STUD_SIXTEENTHS / PIXELS_PER_STUD as i64;
const SAMPLES: i64 = SAMPLES_PER_PIXEL_SIDE as i64;
const SAMPLE_SIXTEENTHS: i64 = PIXEL_SIXTEENTHS / SAMPLES;
const SAMPLE_CENTRE_SIXTEENTHS: i64 = SAMPLE_SIXTEENTHS / 2;
const _: () = assert!(PIXEL_SIXTEENTHS * PIXELS_PER_STUD as i64 == STUD_SIXTEENTHS);
const _: () = assert!(SAMPLE_SIXTEENTHS * SAMPLES == PIXEL_SIXTEENTHS);
const _: () = assert!(SAMPLE_CENTRE_SIXTEENTHS * 2 == SAMPLE_SIXTEENTHS);
const MAX_COORDINATE_SIXTEENTHS: f64 = (1u64 << 36) as f64;
const MAX_HEIGHT_SPAN_SIXTEENTHS: i64 = 1 << 24;
const TILE_SAMPLES: i64 = 256;
const _: () = assert!(TILE_SAMPLES % SAMPLES == 0);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Layer {
    Opaque = 0,
    Clear = 1,
}

type Point = [i64; 3];
const X: usize = 0;
const Y: usize = 1;
const Z: usize = 2;

struct PlanTriangle {
    corners: [Point; 3],
    color: u32,
    layer: Layer,
}

pub(super) struct PlanTriangles<'a> {
    translucent: &'a HashSet<u32>,
    triangles: Vec<PlanTriangle>,
}

fn sixteenths(value: f64) -> Result<i64, GlyphError> {
    let scaled = (value * SIXTEENTHS_PER_LDU as f64).round();
    if scaled.is_finite() && scaled.abs() <= MAX_COORDINATE_SIXTEENTHS {
        Ok(scaled as i64)
    } else {
        Err(GlyphError::Unplaceable)
    }
}

fn faces_up([a, b, c]: &[Point; 3]) -> bool {
    let u = [i128::from(b[X] - a[X]), i128::from(b[Z] - a[Z])];
    let v = [i128::from(c[X] - a[X]), i128::from(c[Z] - a[Z])];
    u[1] * v[0] - u[0] * v[1] > 0
}

impl<'a> PlanTriangles<'a> {
    pub(super) fn new(translucent: &'a HashSet<u32>) -> Self {
        PlanTriangles {
            translucent,
            triangles: Vec::new(),
        }
    }

    pub(super) fn add(
        &mut self,
        mesh: &Mesh,
        matrix: &Affine,
        inherited: u32,
    ) -> Result<(), GlyphError> {
        let points = mesh
            .positions
            .as_chunks::<3>()
            .0
            .iter()
            .map(|p| {
                let placed = matrix.apply([f64::from(p[0]), f64::from(p[1]), f64::from(p[2])]);
                Ok([
                    sixteenths(placed[X])?,
                    sixteenths(placed[Y])?,
                    sixteenths(placed[Z])?,
                ])
            })
            .collect::<Result<Vec<Point>, GlyphError>>()?;
        for group in &mesh.groups {
            let color = resolve_color(group.color, inherited);
            let layer = if self.translucent.contains(&color) {
                Layer::Clear
            } else {
                Layer::Opaque
            };
            for corners in group.indices.as_chunks::<3>().0 {
                let corners = corners.map(|index| points[index as usize]);
                if faces_up(&corners) {
                    self.triangles.push(PlanTriangle {
                        corners,
                        color,
                        layer,
                    });
                }
            }
        }
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct SampleRect {
    x0: i64,
    z0: i64,
    x1: i64,
    z1: i64,
}

impl SampleRect {
    fn within(&self, other: &SampleRect) -> Option<SampleRect> {
        let rect = SampleRect {
            x0: self.x0.max(other.x0),
            z0: self.z0.max(other.z0),
            x1: self.x1.min(other.x1),
            z1: self.z1.min(other.z1),
        };
        (rect.x0 <= rect.x1 && rect.z0 <= rect.z1).then_some(rect)
    }
}

fn ceil_div(value: i64, divisor: i64) -> i64 {
    -(-value).div_euclid(divisor)
}

fn sample_centre(index: i64) -> i64 {
    index * SAMPLE_SIXTEENTHS + SAMPLE_CENTRE_SIXTEENTHS
}

fn sample_span(corners: &[Point; 3]) -> SampleRect {
    let low = |axis: usize| corners.iter().map(|p| p[axis]).min().unwrap_or_default();
    let high = |axis: usize| corners.iter().map(|p| p[axis]).max().unwrap_or_default();
    let first = |axis: usize| ceil_div(low(axis) - SAMPLE_CENTRE_SIXTEENTHS, SAMPLE_SIXTEENTHS);
    let last = |axis: usize| (high(axis) - SAMPLE_CENTRE_SIXTEENTHS).div_euclid(SAMPLE_SIXTEENTHS);
    SampleRect {
        x0: first(X),
        z0: first(Z),
        x1: last(X),
        z1: last(Z),
    }
}

struct Extent {
    origin_pixels: [i64; 2],
    width: i64,
    depth: i64,
    floor: i64,
}

impl Extent {
    fn of(triangles: &[PlanTriangle]) -> Result<Self, GlyphError> {
        let mut min = [i64::MAX; 3];
        let mut max = [i64::MIN; 3];
        for corner in triangles.iter().flat_map(|triangle| &triangle.corners) {
            for axis in [X, Y, Z] {
                min[axis] = min[axis].min(corner[axis]);
                max[axis] = max[axis].max(corner[axis]);
            }
        }
        let first = [
            min[X].div_euclid(PIXEL_SIXTEENTHS),
            min[Z].div_euclid(PIXEL_SIXTEENTHS),
        ];
        let width = (max[X].div_euclid(PIXEL_SIXTEENTHS) - first[0] + 1) as u64;
        let depth = (max[Z].div_euclid(PIXEL_SIXTEENTHS) - first[1] + 1) as u64;
        let side = u64::from(MAX_SIDE_PIXELS);
        if width > side || depth > side || width * depth > MAX_PIXELS {
            return Err(GlyphError::TooLarge { width, depth });
        }
        let height = max[Y] - min[Y];
        if height > MAX_HEIGHT_SPAN_SIXTEENTHS {
            return Err(GlyphError::TooTall { sixteenths: height });
        }
        Ok(Extent {
            origin_pixels: first,
            width: width as i64,
            depth: depth as i64,
            floor: min[Y],
        })
    }

    fn localize(&self, point: &mut Point) {
        point[X] -= self.origin_pixels[0] * PIXEL_SIXTEENTHS;
        point[Y] -= self.floor;
        point[Z] -= self.origin_pixels[1] * PIXEL_SIXTEENTHS;
    }

    fn samples(&self) -> SampleRect {
        SampleRect {
            x0: 0,
            z0: 0,
            x1: self.width * SAMPLES - 1,
            z1: self.depth * SAMPLES - 1,
        }
    }
}

struct Edge {
    from: [i64; 2],
    step: [i64; 2],
}

impl Edge {
    fn at(&self, x: i64, z: i64) -> i64 {
        self.step[1] * (x - self.from[0]) - self.step[0] * (z - self.from[1])
    }
}

struct Plane {
    anchor: Point,
    normal: [i64; 3],
}

impl Plane {
    fn through([a, b, c]: &[Point; 3]) -> Self {
        let u = [b[X] - a[X], b[Y] - a[Y], b[Z] - a[Z]];
        let v = [c[X] - a[X], c[Y] - a[Y], c[Z] - a[Z]];
        Plane {
            anchor: *a,
            normal: [
                u[Y] * v[Z] - u[Z] * v[Y],
                u[Z] * v[X] - u[X] * v[Z],
                u[X] * v[Y] - u[Y] * v[X],
            ],
        }
    }

    fn scaled_height(&self, x: i64, z: i64) -> i128 {
        i128::from(self.anchor[Y]) * i128::from(self.normal[Y])
            - i128::from(self.normal[X]) * i128::from(x - self.anchor[X])
            - i128::from(self.normal[Z]) * i128::from(z - self.anchor[Z])
    }
}

struct Top {
    filled: Vec<bool>,
    height: Vec<i128>,
    scale: Vec<i64>,
    color: Vec<u32>,
}

impl Top {
    fn new(samples: usize) -> Self {
        Top {
            filled: vec![false; samples],
            height: vec![0; samples],
            scale: vec![1; samples],
            color: vec![0; samples],
        }
    }

    fn offer(&mut self, at: usize, height: i128, scale: i64, color: u32) {
        if self.filled[at] {
            let mine = height * i128::from(self.scale[at]);
            let held = self.height[at] * i128::from(scale);
            if mine < held || (mine == held && color >= self.color[at]) {
                return;
            }
        }
        self.filled[at] = true;
        self.height[at] = height;
        self.scale[at] = scale;
        self.color[at] = color;
    }
}

struct Tile {
    rect: SampleRect,
    opaque: Top,
    clear: Top,
}

impl Tile {
    fn new() -> Self {
        let samples = (TILE_SAMPLES * TILE_SAMPLES) as usize;
        Tile {
            rect: SampleRect {
                x0: 0,
                z0: 0,
                x1: -1,
                z1: -1,
            },
            opaque: Top::new(samples),
            clear: Top::new(samples),
        }
    }

    fn reset(&mut self, rect: SampleRect) {
        self.rect = rect;
        self.opaque.filled.fill(false);
        self.clear.filled.fill(false);
    }

    fn index(rect: &SampleRect, x: i64, z: i64) -> usize {
        ((x - rect.x0) + TILE_SAMPLES * (z - rect.z0)) as usize
    }

    fn draw(&mut self, triangle: &PlanTriangle) {
        let Some(span) = sample_span(&triangle.corners).within(&self.rect) else {
            return;
        };
        let [a, b, c] = triangle.corners;
        let plane = Plane::through(&triangle.corners);
        let edges = [(a, b), (b, c), (c, a)].map(|(p, q)| Edge {
            from: [p[X], p[Z]],
            step: [q[X] - p[X], q[Z] - p[Z]],
        });
        let steps = edges
            .each_ref()
            .map(|edge| edge.step[1] * SAMPLE_SIXTEENTHS);
        let rect = self.rect;
        let top = match triangle.layer {
            Layer::Opaque => &mut self.opaque,
            Layer::Clear => &mut self.clear,
        };
        for sz in span.z0..=span.z1 {
            let cz = sample_centre(sz);
            let first = sample_centre(span.x0);
            let mut weights = edges.each_ref().map(|edge| edge.at(first, cz));
            for sx in span.x0..=span.x1 {
                if weights.iter().all(|&weight| weight >= 0) {
                    top.offer(
                        Tile::index(&rect, sx, sz),
                        plane.scaled_height(sample_centre(sx), cz),
                        plane.normal[Y],
                        triangle.color,
                    );
                }
                for (weight, step) in weights.iter_mut().zip(steps) {
                    *weight += step;
                }
            }
        }
    }

    fn sample(&self, x: i64, z: i64) -> Option<(Layer, u32)> {
        let at = Tile::index(&self.rect, x, z);
        if self.opaque.filled[at] {
            Some((Layer::Opaque, self.opaque.color[at]))
        } else if self.clear.filled[at] {
            Some((Layer::Clear, self.clear.color[at]))
        } else {
            None
        }
    }
}

#[derive(Default)]
struct Tally {
    counts: Vec<(u32, u32)>,
}

impl Tally {
    fn add(&mut self, color: u32) {
        match self.counts.iter_mut().find(|(held, _)| *held == color) {
            Some((_, count)) => *count += 1,
            None => self.counts.push((color, 1)),
        }
    }

    fn dominant(&self) -> Option<u32> {
        self.counts
            .iter()
            .max_by(|(a, a_count), (b, b_count)| a_count.cmp(b_count).then(b.cmp(a)))
            .map(|&(color, _)| color)
    }

    fn clear(&mut self) {
        self.counts.clear();
    }
}

struct Pixels {
    width: i64,
    depth: i64,
    coverage: Vec<u8>,
    color: Vec<u32>,
}

impl Pixels {
    fn new(width: i64, depth: i64) -> Self {
        Pixels {
            width,
            depth,
            coverage: vec![0; (width * depth) as usize],
            color: vec![0; (width * depth) as usize],
        }
    }

    fn resolve(&mut self, tile: &Tile, mask: &mut SampleMask) {
        let rect = &tile.rect;
        let mut opaque = Tally::default();
        let mut clear = Tally::default();
        for pz in rect.z0 / SAMPLES..=rect.z1 / SAMPLES {
            for px in rect.x0 / SAMPLES..=rect.x1 / SAMPLES {
                let mut covered = 0u8;
                opaque.clear();
                clear.clear();
                for sz in pz * SAMPLES..(pz + 1) * SAMPLES {
                    for sx in px * SAMPLES..(px + 1) * SAMPLES {
                        let Some((layer, color)) = tile.sample(sx, sz) else {
                            continue;
                        };
                        covered += 1;
                        match layer {
                            Layer::Opaque => opaque.add(color),
                            Layer::Clear => clear.add(color),
                        }
                        mask.set(sx as usize, sz as usize);
                    }
                }
                if covered > 0 {
                    let at = (px + self.width * pz) as usize;
                    self.coverage[at] = covered;
                    self.color[at] = opaque.dominant().or(clear.dominant()).unwrap_or_default();
                }
            }
        }
    }

    fn covered_bounds(&self) -> Option<SampleRect> {
        let mut bounds: Option<SampleRect> = None;
        for z in 0..self.depth {
            for x in 0..self.width {
                if self.coverage[(x + self.width * z) as usize] == 0 {
                    continue;
                }
                let held = bounds.get_or_insert(SampleRect {
                    x0: x,
                    z0: z,
                    x1: x,
                    z1: z,
                });
                held.x0 = held.x0.min(x);
                held.x1 = held.x1.max(x);
                held.z1 = held.z1.max(z);
            }
        }
        bounds
    }
}

pub(super) fn rasterize(plan: PlanTriangles) -> Result<Glyph, GlyphError> {
    let mut triangles = plan.triangles;
    if triangles.is_empty() {
        return Ok(Glyph::empty());
    }
    let extent = Extent::of(&triangles)?;
    let samples = extent.samples();
    let tiles_wide = ceil_div(samples.x1 + 1, TILE_SAMPLES);
    let tiles_deep = ceil_div(samples.z1 + 1, TILE_SAMPLES);
    let mut bins: Vec<Vec<u32>> = vec![Vec::new(); (tiles_wide * tiles_deep) as usize];
    for (index, triangle) in triangles.iter_mut().enumerate() {
        for corner in &mut triangle.corners {
            extent.localize(corner);
        }
        let Some(span) = sample_span(&triangle.corners).within(&samples) else {
            continue;
        };
        for tz in span.z0 / TILE_SAMPLES..=span.z1 / TILE_SAMPLES {
            for tx in span.x0 / TILE_SAMPLES..=span.x1 / TILE_SAMPLES {
                bins[(tx + tiles_wide * tz) as usize].push(index as u32);
            }
        }
    }
    let mut mask = SampleMask::new((samples.x1 + 1) as usize, (samples.z1 + 1) as usize);
    let mut pixels = Pixels::new(extent.width, extent.depth);
    let mut tile = Tile::new();
    for tz in 0..tiles_deep {
        for tx in 0..tiles_wide {
            let bin = &bins[(tx + tiles_wide * tz) as usize];
            if bin.is_empty() {
                continue;
            }
            tile.reset(SampleRect {
                x0: tx * TILE_SAMPLES,
                z0: tz * TILE_SAMPLES,
                x1: ((tx + 1) * TILE_SAMPLES - 1).min(samples.x1),
                z1: ((tz + 1) * TILE_SAMPLES - 1).min(samples.z1),
            });
            for &index in bin {
                tile.draw(&triangles[index as usize]);
            }
            pixels.resolve(&tile, &mut mask);
        }
    }
    match pixels.covered_bounds() {
        Some(crop) => cropped(&extent, &pixels, &crop, &mask),
        None => Ok(Glyph::empty()),
    }
}

fn cropped(
    extent: &Extent,
    pixels: &Pixels,
    crop: &SampleRect,
    mask: &SampleMask,
) -> Result<Glyph, GlyphError> {
    let width = crop.x1 - crop.x0 + 1;
    let depth = crop.z1 - crop.z0 + 1;
    let mut coverage = Vec::with_capacity((width * depth) as usize);
    let mut colors = Vec::with_capacity((width * depth) as usize);
    for z in crop.z0..=crop.z1 {
        for x in crop.x0..=crop.x1 {
            let at = (x + pixels.width * z) as usize;
            coverage.push(pixels.coverage[at]);
            colors.push(pixels.color[at]);
        }
    }
    let palette: Vec<u32> = coverage
        .iter()
        .zip(&colors)
        .filter(|(&count, _)| count > 0)
        .map(|(_, &color)| color)
        .collect::<BTreeSet<u32>>()
        .into_iter()
        .collect();
    if palette.len() > MAX_COLORS {
        return Err(GlyphError::TooManyColors {
            colors: palette.len(),
        });
    }
    let color_index = coverage
        .iter()
        .zip(&colors)
        .map(
            |(&count, color)| match (count, palette.binary_search(color)) {
                (0, _) | (_, Err(_)) => 0,
                (_, Ok(index)) => index as u16,
            },
        )
        .collect();
    let origin_x =
        i32::try_from(extent.origin_pixels[0] + crop.x0).map_err(|_| GlyphError::Unplaceable)?;
    let origin_z =
        i32::try_from(extent.origin_pixels[1] + crop.z0).map_err(|_| GlyphError::Unplaceable)?;
    Ok(Glyph {
        origin: [origin_x, origin_z],
        width: width as u32,
        depth: depth as u32,
        colors: palette,
        coverage,
        color_index,
        outline: trace(
            mask,
            (crop.x0 * SAMPLES) as usize..((crop.x1 + 1) * SAMPLES) as usize,
            (crop.z0 * SAMPLES) as usize..((crop.z1 + 1) * SAMPLES) as usize,
        ),
    })
}
