use rustc_hash::FxHashMap;

use super::ray::{cross, dot, sub, unit, Ray, HIT_EPSILON};
use super::triangle_tree::TriangleTree;
use super::{
    broad_cell, ModelSolids, Segment, StudFrame, StudShape, BELOW_ELEVATION_STEPS,
    BELOW_ELEVATION_STEP_DEGREES, BELOW_HEIGHT_STEPS, BELOW_REACH_LDU, BELOW_START_OUTSIDE,
};
use crate::affine::Vec3;

const FLOAT_ERROR_BOUND_LDU: f64 = 1e-6;
const SAME_POSE_BOUND_LDU: f64 = 1e-9;
const UNIT_SCALE_BOUND: f64 = 1e-12;
const LARGEST_BOUNDED_COORDINATE_LDU: f64 = 1e6;
const OFFSET_KEY_PER_LDU: f64 = 1e6;
const CERTIFICATES_PER_SETTING: usize = 32;
const ESCAPES_KEPT: usize = 8;
const ESCAPE_TRIES: usize = 2;
const RAYS_PER_RADIAL: usize = BELOW_HEIGHT_STEPS * BELOW_ELEVATION_STEPS;
const ALL_STEPS: u64 = (1 << BELOW_ELEVATION_STEPS) - 1;

struct Contact {
    point: Vec3,
    distance: f64,
    reach: f64,
    u: f64,
    v: f64,
    determinant: f64,
}

impl Contact {
    fn of(points: &[Vec3; 3], ray: &Ray) -> Option<Self> {
        let edge1 = sub(points[1], points[0]);
        let edge2 = sub(points[2], points[0]);
        let p = cross(ray.direction, edge2);
        let determinant = dot(edge1, p);
        if determinant == 0.0 {
            return None;
        }
        let s = sub(ray.origin, points[0]);
        let q = cross(s, edge1);
        let distance = dot(edge2, q) / determinant;
        Some(Contact {
            point: [0, 1, 2].map(|axis| ray.origin[axis] + ray.direction[axis] * distance),
            distance,
            reach: ray.reach,
            u: dot(s, p) / determinant,
            v: dot(ray.direction, q) / determinant,
            determinant,
        })
    }
}

#[derive(Clone, Copy)]
struct Clearance {
    edges: [f64; 3],
    low: Vec3,
    high: Vec3,
}

impl Clearance {
    const UNBOUNDED: Clearance = Clearance {
        edges: [f64::INFINITY; 3],
        low: [f64::INFINITY; 3],
        high: [f64::INFINITY; 3],
    };

    fn meets_bound(&self) -> bool {
        self.edges
            .iter()
            .chain(&self.low)
            .chain(&self.high)
            .all(|&room| room >= 0.0)
    }

    fn tightest(&self, other: &Clearance) -> Clearance {
        Clearance {
            edges: [0, 1, 2].map(|k| self.edges[k].min(other.edges[k])),
            low: [0, 1, 2].map(|k| self.low[k].min(other.low[k])),
            high: [0, 1, 2].map(|k| self.high[k].min(other.high[k])),
        }
    }

    fn scaled(&self, factor: f64) -> Clearance {
        Clearance {
            edges: self.edges.map(|room| room * factor),
            low: self.low.map(|room| room * factor),
            high: self.high.map(|room| room * factor),
        }
    }
}

#[derive(Clone, Copy)]
struct Face {
    double_area: f64,
    altitudes: [f64; 3],
    min: Vec3,
    max: Vec3,
    flat: Option<usize>,
}

fn flat_axes(points: &[Vec3; 3]) -> impl Iterator<Item = usize> + '_ {
    let [a, b, c] = points;
    (0..3).filter(move |&axis| a[axis] == b[axis] && b[axis] == c[axis])
}

impl Face {
    fn of(points: &[Vec3; 3]) -> Self {
        let [a, b, c] = *points;
        let normal = cross(sub(b, a), sub(c, a));
        let double_area = dot(normal, normal).sqrt();
        let length = |p: Vec3, q: Vec3| dot(sub(q, p), sub(q, p)).sqrt();
        Face {
            double_area,
            altitudes: [length(b, c), length(a, c), length(a, b)].map(|edge| double_area / edge),
            min: [0, 1, 2].map(|axis| a[axis].min(b[axis]).min(c[axis])),
            max: [0, 1, 2].map(|axis| a[axis].max(b[axis]).max(c[axis])),
            flat: flat_axes(points).next(),
        }
    }

    fn sides(&self, room: impl Fn(usize) -> (f64, f64)) -> (Vec3, Vec3) {
        let mut low = [f64::INFINITY; 3];
        let mut high = [f64::INFINITY; 3];
        for axis in (0..3).filter(|&axis| self.flat != Some(axis)) {
            (low[axis], high[axis]) = room(axis);
        }
        (low, high)
    }

    fn certify(&self, contact: &Contact) -> Option<Clearance> {
        let required = FLOAT_ERROR_BOUND_LDU * self.double_area / contact.determinant.abs();
        let clear_along = contact.determinant.abs() >= 2.0 * HIT_EPSILON
            && contact.distance - HIT_EPSILON >= required
            && contact.reach - contact.distance >= required;
        if !clear_along {
            return None;
        }
        let weights = [1.0 - contact.u - contact.v, contact.u, contact.v];
        let (low, high) = self.sides(|axis| {
            (
                contact.point[axis] - self.min[axis] - required,
                self.max[axis] - contact.point[axis] - required,
            )
        });
        let clearance = Clearance {
            edges: [0, 1, 2].map(|k| weights[k] * self.altitudes[k] - required),
            low,
            high,
        };
        clearance.meets_bound().then_some(clearance)
    }
}

pub(super) fn certifiable_faces(points: &[[Vec3; 3]], tree: &TriangleTree) -> Vec<bool> {
    let mut certifiable: Vec<bool> = points
        .iter()
        .map(|points| {
            let face = Face::of(points);
            face.double_area > 0.0
                && face.altitudes.iter().all(|altitude| altitude.is_finite())
                && flat_axes(points).count() <= 1
        })
        .collect();
    tree.each_leaf(|triangles, ancestors| {
        for t in triangles {
            let Some(axis) = flat_axes(&points[t]).next() else {
                continue;
            };
            let plane = points[t][0][axis];
            let pinned = ancestors.iter().all(|bounds| {
                (bounds.min[axis] == plane && bounds.max[axis] == plane)
                    || bounds.max[axis] - bounds.min[axis] >= FLOAT_ERROR_BOUND_LDU
            });
            certifiable[t] &= pinned;
        }
    });
    certifiable
}

pub(super) fn coordinates_bounded(boxes: &[[Vec3; 2]]) -> bool {
    boxes
        .iter()
        .flatten()
        .flatten()
        .all(|v| v.abs() <= LARGEST_BOUNDED_COORDINATE_LDU)
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Form {
    part: usize,
    clear: bool,
    rotation: [u64; 9],
}

struct Anchor {
    form: Form,
    offset: Vec3,
}

impl ModelSolids<'_> {
    fn reaches(&self, instance: usize, segment: &Segment) -> bool {
        self.placed[instance]
            .as_ref()
            .is_some_and(|placed| placed.blocks && placed.cells.shares_cell(&segment.cells))
    }

    fn exact_witness(
        &self,
        instance: usize,
        segment: &Segment,
        blocked: &mut bool,
    ) -> Option<(usize, Clearance)> {
        let placed = self.placed[instance].as_ref()?;
        let ray = placed.local(segment)?;
        let solid = &self.solids[placed.part];
        let points = &solid.tree_points;
        solid.tree.find_hit(
            &ray,
            self.counts(placed),
            |t| {
                if !solid.certifiable[t] {
                    return None;
                }
                let contact = Contact::of(&points[t], &ray)?;
                Face::of(&points[t])
                    .certify(&contact)
                    .map(|clearance| (t, clearance))
            },
            blocked,
        )
    }
}

#[derive(Clone, Copy)]
pub(super) struct BelowStud {
    pub frame: StudFrame,
    pub rotation: [u64; 9],
    pub owner: usize,
    pub coverer: usize,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Setting {
    stud: [u64; 9],
    owner: Form,
    coverer: Form,
    offset: [i64; 3],
}

struct Slide {
    triangle: usize,
    clearance: Clearance,
}

struct Certificate {
    seat: Vec3,
    slides: Vec<Slide>,
    anchors: Vec<Anchor>,
    exact_rays: Vec<usize>,
}

enum Verdict {
    Certified {
        instance: usize,
        triangle: usize,
        clearance: Clearance,
    },
    ExactBlocked,
    ExactOpen,
}

struct Prepared {
    face: Face,
    rigid: bool,
    origin: Vec3,
    radial: Vec3,
    up: Vec3,
    lengths: [f64; 3],
    normal: [f64; 2],
    across: [f64; 2],
    turn: [f64; 2],
    depth: f64,
}

impl Prepared {
    fn contact(&self, (rise, run): (f64, f64)) -> Contact {
        let [radial, both, up] = self.lengths;
        let scale = (run * run * radial + 2.0 * run * rise * both + rise * rise * up).sqrt();
        let along = |[r, u]: [f64; 2]| run * r + rise * u;
        let normal = -along(self.normal);
        Contact {
            point: [0, 1, 2].map(|axis| {
                self.origin[axis]
                    + (self.radial[axis] * run + self.up[axis] * rise) * self.depth / normal
            }),
            distance: self.depth * scale / normal,
            reach: BELOW_REACH_LDU * scale,
            u: along(self.across) / normal,
            v: along(self.turn) / normal,
            determinant: normal / scale,
        }
    }

    fn rigid_certify(&self, (rise, run): (f64, f64)) -> Option<Clearance> {
        let along = |[r, u]: [f64; 2]| run * r + rise * u;
        let normal = -along(self.normal);
        let sign = normal.signum();
        let size = normal.abs();
        let required = FLOAT_ERROR_BOUND_LDU * self.face.double_area;
        let depth = self.depth * sign;
        let clear_along = size >= 2.0 * HIT_EPSILON
            && depth - HIT_EPSILON * size >= required
            && BELOW_REACH_LDU * size - depth >= required;
        if !clear_along {
            return None;
        }
        let across = along(self.across) * sign;
        let turn = along(self.turn) * sign;
        let face = &self.face;
        let (low, high) = face.sides(|axis| {
            let travel = (self.radial[axis] * run + self.up[axis] * rise) * depth;
            (
                (self.origin[axis] - face.min[axis]) * size + travel - required,
                (face.max[axis] - self.origin[axis]) * size - travel - required,
            )
        });
        let weights = [size - across - turn, across, turn];
        let scaled = Clearance {
            edges: [0, 1, 2].map(|k| weights[k] * face.altitudes[k] - required),
            low,
            high,
        };
        scaled.meets_bound().then(|| scaled.scaled(size.recip()))
    }

    fn certify(&self, slope: (f64, f64)) -> Option<Clearance> {
        if self.rigid {
            self.rigid_certify(slope)
        } else {
            self.face.certify(&self.contact(slope))
        }
    }

    fn keeps_depth_between(&self) -> bool {
        let widest = (self.normal[0] * self.normal[0] + self.normal[1] * self.normal[1]).sqrt();
        let required = FLOAT_ERROR_BOUND_LDU * self.face.double_area;
        self.depth.abs() - HIT_EPSILON * widest >= 2.0 * required
    }

    fn cover_between(&self, slopes: &[(f64, f64)], pending: u64) -> (u64, Clearance) {
        let mut rest = pending;
        let first_certified = |rest: &mut u64, step_of: fn(u64) -> usize| {
            while *rest != 0 {
                let step = step_of(*rest);
                *rest &= !(1 << step);
                if let Some(clearance) = self.rigid_certify(slopes[step]) {
                    return Some((step, clearance));
                }
            }
            None
        };
        let lowest = |bits: u64| bits.trailing_zeros() as usize;
        let highest = |bits: u64| (u64::BITS - 1 - bits.leading_zeros()) as usize;
        let Some((low, low_clearance)) = first_certified(&mut rest, lowest) else {
            return (0, Clearance::UNBOUNDED);
        };
        let Some((high, high_clearance)) = first_certified(&mut rest, highest) else {
            return (1 << low, low_clearance);
        };
        let between = (u64::MAX << low) & (u64::MAX >> (u64::BITS as usize - 1 - high));
        (pending & between, low_clearance.tightest(&high_clearance))
    }

    fn cover(&self, slopes: &[(f64, f64)], pending: u64) -> (u64, Clearance) {
        if self.rigid && pending.count_ones() > 2 && self.keeps_depth_between() {
            return self.cover_between(slopes, pending);
        }
        let mut covered = 0;
        let mut tightest = Clearance::UNBOUNDED;
        let mut steps = pending;
        while steps != 0 {
            let step = steps.trailing_zeros() as usize;
            steps &= steps - 1;
            if let Some(clearance) = self.certify(slopes[step]) {
                covered |= 1 << step;
                tightest = tightest.tightest(&clearance);
            }
        }
        (covered, tightest)
    }
}

#[derive(Clone, Copy)]
struct Fan {
    origin: Vec3,
    radial: Vec3,
    up: Vec3,
}

struct Proof {
    owner: usize,
    slides: Vec<Slide>,
    others: Vec<usize>,
    exact_rays: Vec<usize>,
}

impl Proof {
    fn record(&mut self, instance: usize, triangle: usize, clearance: &Clearance) {
        if instance != self.owner {
            if !self.others.contains(&instance) {
                self.others.push(instance);
            }
            return;
        }
        match self
            .slides
            .iter_mut()
            .find(|slide| slide.triangle == triangle)
        {
            Some(slide) => slide.clearance = slide.clearance.tightest(clearance),
            None => self.slides.push(Slide {
                triangle,
                clearance: *clearance,
            }),
        }
    }
}

pub(super) struct BelowCertifier<'m, 'a> {
    model: &'m ModelSolids<'a>,
    shape: StudShape,
    bounded: bool,
    slopes: Vec<(f64, f64)>,
    certificates: FxHashMap<Setting, Vec<Certificate>>,
    escapes: Vec<usize>,
    radials: Vec<Vec3>,
}

impl<'m, 'a> BelowCertifier<'m, 'a> {
    pub fn new(model: &'m ModelSolids<'a>, shape: StudShape) -> Self {
        let slopes = (1..=BELOW_ELEVATION_STEPS)
            .map(|step| {
                (-BELOW_ELEVATION_STEP_DEGREES * step as f64)
                    .to_radians()
                    .sin_cos()
            })
            .collect();
        BelowCertifier {
            model,
            shape,
            bounded: model.coordinates_bounded,
            slopes,
            certificates: FxHashMap::default(),
            escapes: Vec::new(),
            radials: Vec::new(),
        }
    }

    pub fn closed(&mut self, stud: &BelowStud) -> bool {
        self.radials = stud.frame.radials();
        let rays = self.radials.len() * RAYS_PER_RADIAL;
        if !self.bounded {
            return (0..rays).all(|ray| self.blocked(stud, ray));
        }
        let setting = self.setting(stud);
        if let Some(verdict) = setting.and_then(|setting| self.reuse(&setting, stud)) {
            return verdict;
        }
        let tries: Vec<usize> = self
            .escapes
            .iter()
            .rev()
            .take(ESCAPE_TRIES)
            .copied()
            .filter(|&ray| ray < rays)
            .collect();
        if tries.into_iter().any(|ray| !self.blocked(stud, ray)) {
            return false;
        }
        let Some(certificate) = self.certify(stud, rays) else {
            return false;
        };
        if let Some(setting) = setting {
            let kept = self.certificates.entry(setting).or_default();
            if kept.len() < CERTIFICATES_PER_SETTING {
                kept.push(certificate);
            }
        }
        true
    }

    fn setting(&self, stud: &BelowStud) -> Option<Setting> {
        let model = self.model;
        let coverer = model.placed[stud.coverer].as_ref()?;
        let offset = sub(coverer.translation, stud.frame.base);
        Some(Setting {
            stud: stud.rotation,
            owner: self.form(stud.owner)?,
            coverer: self.form(stud.coverer)?,
            offset: offset.map(|v| (v * OFFSET_KEY_PER_LDU).round() as i64),
        })
    }

    fn reuse(&mut self, setting: &Setting, stud: &BelowStud) -> Option<bool> {
        let base = stud.frame.base;
        let seat = self.seat(stud.owner, base)?;
        let exact_rays = self
            .certificates
            .get(setting)?
            .iter()
            .find(|certificate| {
                let delta = sub(seat, certificate.seat);
                certificate
                    .slides
                    .iter()
                    .all(|slide| self.slides(stud.owner, slide, delta))
                    && certificate
                        .anchors
                        .iter()
                        .all(|anchor| self.holds(anchor, base))
            })?
            .exact_rays
            .clone();
        Some(exact_rays.into_iter().all(|ray| self.blocked(stud, ray)))
    }

    fn form(&self, instance: usize) -> Option<Form> {
        self.model.placed[instance].as_ref().map(|placed| Form {
            part: placed.part,
            clear: !placed.inherited_opaque,
            rotation: placed.rotation,
        })
    }

    fn anchor(&self, instance: usize, base: Vec3) -> Option<Anchor> {
        let placed = self.model.placed[instance].as_ref()?;
        Some(Anchor {
            form: self.form(instance)?,
            offset: sub(placed.translation, base),
        })
    }

    fn holds(&self, anchor: &Anchor, base: Vec3) -> bool {
        let target = [0, 1, 2].map(|axis| base[axis] + anchor.offset[axis]);
        let lo = target.map(|v| broad_cell(v - SAME_POSE_BOUND_LDU));
        let hi = target.map(|v| broad_cell(v + SAME_POSE_BOUND_LDU));
        let matches = |j: &usize| {
            self.form(*j) == Some(anchor.form)
                && self.model.placed[*j].as_ref().is_some_and(|placed| {
                    (0..3).all(|axis| {
                        (placed.translation[axis] - target[axis]).abs() <= SAME_POSE_BOUND_LDU
                    })
                })
        };
        (lo[0]..=hi[0]).any(|x| {
            (lo[1]..=hi[1]).any(|y| {
                (lo[2]..=hi[2]).any(|z| {
                    self.model
                        .anchors
                        .get(&[x, y, z])
                        .is_some_and(|instances| instances.iter().any(matches))
                })
            })
        })
    }

    fn seat(&self, instance: usize, base: Vec3) -> Option<Vec3> {
        self.model.placed[instance]
            .as_ref()
            .map(|placed| placed.inverse.apply(base))
    }

    fn slides(&self, owner: usize, slide: &Slide, delta: Vec3) -> bool {
        let Some(placed) = &self.model.placed[owner] else {
            return false;
        };
        let [a, b, c] = self.model.solids[placed.part].tree_points[slide.triangle];
        let normal = unit(cross(sub(b, a), sub(c, a)));
        if dot(normal, delta).abs() > SAME_POSE_BOUND_LDU {
            return false;
        }
        let inward = [sub(c, b), sub(a, c), sub(b, a)].map(|edge| unit(cross(normal, edge)));
        (0..3).all(|k| {
            slide.clearance.edges[k] + dot(inward[k], delta) >= 0.0
                && slide.clearance.low[k] + delta[k] >= 0.0
                && slide.clearance.high[k] - delta[k] >= 0.0
        })
    }

    fn fan(&self, frame: &StudFrame, fan: usize) -> (Vec3, Vec3) {
        let radial = self.radials[fan / BELOW_HEIGHT_STEPS];
        let fraction = ((fan % BELOW_HEIGHT_STEPS) as f64 + 0.5) / BELOW_HEIGHT_STEPS as f64;
        let origin = frame.at(
            self.shape.height * fraction,
            radial,
            self.shape.radius * BELOW_START_OUTSIDE,
        );
        (origin, radial)
    }

    fn fan_at(&self, frame: &StudFrame, fan: usize) -> Fan {
        let (origin, radial) = self.fan(frame, fan);
        Fan {
            origin,
            radial,
            up: frame.up,
        }
    }

    fn ray(&self, frame: &StudFrame, index: usize) -> (Vec3, Vec3) {
        let (origin, radial) = self.fan(frame, index / BELOW_ELEVATION_STEPS);
        let (rise, run) = self.slopes[index % BELOW_ELEVATION_STEPS];
        let direction = [0, 1, 2].map(|axis| radial[axis] * run + frame.up[axis] * rise);
        (origin, direction)
    }

    fn blocked(&mut self, stud: &BelowStud, index: usize) -> bool {
        let (origin, direction) = self.ray(&stud.frame, index);
        let blocked = self
            .model
            .search(&Segment::new(origin, direction, BELOW_REACH_LDU))
            .is_some();
        if !blocked {
            self.escaped(index);
        }
        blocked
    }

    fn escaped(&mut self, index: usize) {
        self.escapes.retain(|&ray| ray != index);
        self.escapes.push(index);
        if self.escapes.len() > ESCAPES_KEPT {
            self.escapes.remove(0);
        }
    }

    fn certify(&mut self, stud: &BelowStud, rays: usize) -> Option<Certificate> {
        let mut proof = Proof {
            owner: stud.owner,
            slides: Vec::new(),
            others: Vec::new(),
            exact_rays: Vec::new(),
        };
        let mut previous_fan: Vec<(usize, usize)> = Vec::new();
        let mut fan_used: Vec<(usize, usize)> = Vec::new();
        let mut previous_radial: Vec<(usize, usize)> = Vec::new();
        let mut radial_used: Vec<(usize, usize)> = Vec::new();
        let mut offers: Vec<(usize, usize)> = Vec::new();
        for radial in 0..rays / RAYS_PER_RADIAL {
            let first_fan = radial * BELOW_HEIGHT_STEPS;
            radial_used.clear();
            let unspanned = self.certify_across_heights(
                stud,
                first_fan,
                &previous_radial,
                &mut proof,
                &mut radial_used,
            );
            for fan_index in first_fan..first_fan + BELOW_HEIGHT_STEPS {
                let fan = self.fan_at(&stud.frame, fan_index);
                let mut pending = unspanned;
                fan_used.clear();
                offers.clear();
                offers.extend_from_slice(&previous_fan);
                for witness in &previous_radial {
                    if !offers.contains(witness) {
                        offers.push(*witness);
                    }
                }
                for &witness in &offers {
                    if pending == 0 {
                        break;
                    }
                    self.take(&fan, witness, &mut proof, &mut pending, &mut fan_used);
                }
                while pending != 0 {
                    let step = pending.trailing_zeros() as usize;
                    pending &= !(1 << step);
                    let index = fan_index * BELOW_ELEVATION_STEPS + step;
                    let (ray_origin, direction) = self.ray(&stud.frame, index);
                    match self.exact_walk(ray_origin, direction, stud) {
                        Verdict::Certified {
                            instance,
                            triangle,
                            clearance,
                        } => {
                            proof.record(instance, triangle, &clearance);
                            self.take(
                                &fan,
                                (instance, triangle),
                                &mut proof,
                                &mut pending,
                                &mut fan_used,
                            );
                        }
                        Verdict::ExactBlocked => proof.exact_rays.push(index),
                        Verdict::ExactOpen => {
                            self.escaped(index);
                            return None;
                        }
                    }
                }
                for witness in &fan_used {
                    if !radial_used.contains(witness) {
                        radial_used.push(*witness);
                    }
                }
                std::mem::swap(&mut previous_fan, &mut fan_used);
            }
            std::mem::swap(&mut previous_radial, &mut radial_used);
        }
        let base = stud.frame.base;
        let anchors = proof
            .others
            .into_iter()
            .map(|instance| self.anchor(instance, base))
            .collect::<Option<Vec<Anchor>>>()?;
        Some(Certificate {
            seat: self.seat(stud.owner, base)?,
            slides: proof.slides,
            anchors,
            exact_rays: proof.exact_rays,
        })
    }

    fn certify_across_heights(
        &self,
        stud: &BelowStud,
        first_fan: usize,
        witnesses: &[(usize, usize)],
        proof: &mut Proof,
        spanned_by: &mut Vec<(usize, usize)>,
    ) -> u64 {
        let lowest = self.fan_at(&stud.frame, first_fan);
        let highest = self.fan_at(&stud.frame, first_fan + BELOW_HEIGHT_STEPS - 1);
        let mut pending = ALL_STEPS;
        for &(instance, triangle) in witnesses {
            if pending == 0 {
                break;
            }
            let Some((low, low_clearance)) = self.cover(&lowest, instance, triangle, pending)
            else {
                continue;
            };
            let Some((both, high_clearance)) = self.cover(&highest, instance, triangle, low) else {
                continue;
            };
            pending &= !both;
            proof.record(instance, triangle, &low_clearance.tightest(&high_clearance));
            spanned_by.push((instance, triangle));
        }
        pending
    }

    fn take(
        &self,
        fan: &Fan,
        witness: (usize, usize),
        proof: &mut Proof,
        pending: &mut u64,
        used: &mut Vec<(usize, usize)>,
    ) {
        let (instance, triangle) = witness;
        let Some((covered, clearance)) = self.cover(fan, instance, triangle, *pending) else {
            return;
        };
        *pending &= !covered;
        proof.record(instance, triangle, &clearance);
        if !used.contains(&witness) {
            used.push(witness);
        }
    }

    fn cover(
        &self,
        fan: &Fan,
        instance: usize,
        triangle: usize,
        pending: u64,
    ) -> Option<(u64, Clearance)> {
        let (covered, clearance) = self
            .prepare(fan, instance, triangle)?
            .cover(&self.slopes, pending);
        (covered != 0).then_some((covered, clearance))
    }

    fn prepare(&self, fan: &Fan, instance: usize, triangle: usize) -> Option<Prepared> {
        let Fan { origin, radial, up } = *fan;
        let model = self.model;
        let placed = model.placed[instance].as_ref()?;
        let solid = &model.solids[placed.part];
        if !solid.certifiable[triangle] || !model.counts(placed)(triangle) {
            return None;
        }
        let m = &placed.inverse.m;
        let linear = |v: Vec3| {
            [0, 1, 2].map(|row| m[row * 4] * v[0] + m[row * 4 + 1] * v[1] + m[row * 4 + 2] * v[2])
        };
        let points = &solid.tree_points[triangle];
        let local = placed.inverse.apply(origin);
        let edge1 = sub(points[1], points[0]);
        let edge2 = sub(points[2], points[0]);
        let offset = sub(local, points[0]);
        let turn = cross(offset, edge1);
        let (radial, up) = (linear(radial), linear(up));
        let pair = |v: Vec3| [dot(radial, v), dot(up, v)];
        let lengths = [dot(radial, radial), dot(radial, up), dot(up, up)];
        Some(Prepared {
            face: Face::of(points),
            rigid: (lengths[0] - 1.0).abs() <= UNIT_SCALE_BOUND
                && lengths[1].abs() <= UNIT_SCALE_BOUND
                && (lengths[2] - 1.0).abs() <= UNIT_SCALE_BOUND,
            origin: local,
            radial,
            up,
            lengths,
            normal: pair(cross(edge1, edge2)),
            across: pair(cross(edge2, offset)),
            turn: pair(turn),
            depth: dot(edge2, turn),
        })
    }

    fn exact_walk(&mut self, origin: Vec3, direction: Vec3, stud: &BelowStud) -> Verdict {
        let model = self.model;
        let segment = Segment::new(origin, direction, BELOW_REACH_LDU);
        let mut blocked = false;
        for preferred in [stud.owner, stud.coverer] {
            if !model.reaches(preferred, &segment) {
                continue;
            }
            if let Some((triangle, clearance)) =
                model.exact_witness(preferred, &segment, &mut blocked)
            {
                return Verdict::Certified {
                    instance: preferred,
                    triangle,
                    clearance,
                };
            }
        }
        let mut witness = None;
        model.index.any_along(&segment.ray, |instance| {
            if instance == stud.owner
                || instance == stud.coverer
                || !model.reaches(instance, &segment)
            {
                return false;
            }
            witness = model
                .exact_witness(instance, &segment, &mut blocked)
                .map(|(triangle, clearance)| (instance, triangle, clearance));
            witness.is_some()
        });
        match witness {
            Some((instance, triangle, clearance)) => Verdict::Certified {
                instance,
                triangle,
                clearance,
            },
            None if blocked => Verdict::ExactBlocked,
            None => Verdict::ExactOpen,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CoverInstance, Coverers, Opacity, PartSolid, StudShape};
    use super::*;
    use crate::affine::Affine;
    use crate::flatten::{Triangle, INHERIT_COLOR};
    use crate::mesh;
    use std::collections::HashMap;

    const STUD: StudShape = StudShape {
        height: 4.0,
        radius: 6.0,
    };
    const OPAQUE: u32 = 4;
    const CLEAR: u32 = 47;
    const SCENES: u64 = 7;
    const COVERERS: usize = 14;
    const TUBE_SIDES: usize = 8;
    const GABLE_SLANT_LDU: f64 = 0.1;
    const STRETCH_X: f64 = 1.25;
    const STRETCH_Z: f64 = 0.75;
    const BEYOND_BOUNDED_LDU: f64 = 2e6;
    const REAL_BUILDS: u64 = 3;
    const REAL_PARTS_PER_BUILD: usize = 10;
    const WITNESS_SCENES: u64 = 400;
    const WITNESS_REACH_LDU: f64 = 30.0;
    const FAR_LDU: f64 = 1e5;
    const NEAR_BOUND_LDU: f64 = 1e-2;
    const AFFINE_SLACK_LDU: f64 = 1e-9;

    struct Scene {
        state: u64,
    }

    impl Scene {
        fn next(&mut self, below: u64) -> u64 {
            self.state = self
                .state
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.state >> 33) % below
        }
    }

    fn triangle(out: &mut Vec<Triangle>, points: [Vec3; 3]) {
        out.push(Triangle {
            color: INHERIT_COLOR,
            points,
            double_sided: true,
        });
    }

    fn quad(out: &mut Vec<Triangle>, [a, b, c, d]: [Vec3; 4]) {
        triangle(out, [a, b, c]);
        triangle(out, [a, c, d]);
    }

    fn gabled(half: [f64; 2], depth: f64) -> PartSolid {
        let ([x0, z0], [x1, z1]) = ([-half[0], -half[1]], half);
        let (y0, y1) = (-depth, 0.0);
        let mut t = Vec::new();
        quad(
            &mut t,
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
        );
        quad(
            &mut t,
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
        );
        quad(
            &mut t,
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
        );
        quad(
            &mut t,
            [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
        );
        let slant = y0 + GABLE_SLANT_LDU;
        triangle(&mut t, [[x0, y0, z1], [x1, slant, z1], [x0, y1, z1]]);
        triangle(&mut t, [[x1, slant, z1], [x1, y1, z1], [x0, y1, z1]]);
        PartSolid::from_mesh(&mesh::build(&t, &[]))
    }

    fn shell(half: [f64; 2], depth: f64, open_side: bool, floor: bool) -> PartSolid {
        let ([x0, z0], [x1, z1]) = ([-half[0], -half[1]], half);
        let (y0, y1) = (-depth, 0.0);
        let mut t = Vec::new();
        quad(
            &mut t,
            [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]],
        );
        quad(
            &mut t,
            [[x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1]],
        );
        quad(
            &mut t,
            [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]],
        );
        quad(
            &mut t,
            [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]],
        );
        if !open_side {
            quad(
                &mut t,
                [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]],
            );
        }
        if floor {
            quad(
                &mut t,
                [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
            );
        }
        PartSolid::from_mesh(&mesh::build(&t, &[]))
    }

    fn tube(radius: f64, depth: f64) -> PartSolid {
        let corner = |k: usize, y: f64| {
            let (sin, cos) = (std::f64::consts::TAU * k as f64 / TUBE_SIDES as f64).sin_cos();
            [radius * cos, y, radius * sin]
        };
        let mut t = Vec::new();
        for k in 0..TUBE_SIDES {
            let next = (k + 1) % TUBE_SIDES;
            quad(
                &mut t,
                [
                    corner(k, -depth),
                    corner(next, -depth),
                    corner(next, 0.0),
                    corner(k, 0.0),
                ],
            );
            triangle(&mut t, [[0.0, 0.0, 0.0], corner(k, 0.0), corner(next, 0.0)]);
            triangle(
                &mut t,
                [[0.0, -depth, 0.0], corner(next, -depth), corner(k, -depth)],
            );
        }
        PartSolid::from_mesh(&mesh::build(&t, &[]))
    }

    fn placed(x: f64, y: f64, z: f64, quarter: bool) -> Affine {
        let (c, s) = if quarter { (0.0, 1.0) } else { (1.0, 0.0) };
        Affine {
            m: [c, 0.0, s, x, 0.0, 1.0, 0.0, y, -s, 0.0, c, z],
        }
    }

    fn mirrored(x: f64, y: f64, z: f64) -> Affine {
        Affine {
            m: [-1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, 1.0, z],
        }
    }

    fn squeezed(x: f64, y: f64, z: f64) -> Affine {
        Affine {
            m: [1.0, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, STRETCH_Z, z],
        }
    }

    fn stretched(x: f64, y: f64, z: f64) -> Affine {
        Affine {
            m: [
                STRETCH_X, 0.0, 0.0, x, 0.0, 1.0, 0.0, y, 0.0, 0.0, STRETCH_Z, z,
            ],
        }
    }

    fn unit(scene: &mut Scene) -> f64 {
        scene.next(1 << 30) as f64 / f64::from(1u32 << 30)
    }

    fn around(scene: &mut Scene, reach: f64) -> Vec3 {
        [0, 1, 2].map(|_| (unit(scene) * 2.0 - 1.0) * reach)
    }

    fn turned(scene: &mut Scene, scale: Vec3, at: Vec3) -> Affine {
        let q = [0, 1, 2, 3].map(|_| unit(scene) * 2.0 - 1.0);
        let norm = q.iter().map(|v| v * v).sum::<f64>().sqrt();
        let [w, x, y, z] = q.map(|v| v / norm);
        let r = [
            [
                1.0 - 2.0 * (y * y + z * z),
                2.0 * (x * y - w * z),
                2.0 * (x * z + w * y),
            ],
            [
                2.0 * (x * y + w * z),
                1.0 - 2.0 * (x * x + z * z),
                2.0 * (y * z - w * x),
            ],
            [
                2.0 * (x * z - w * y),
                2.0 * (y * z + w * x),
                1.0 - 2.0 * (x * x + y * y),
            ],
        ];
        Affine {
            m: [
                r[0][0] * scale[0],
                r[0][1] * scale[1],
                r[0][2] * scale[2],
                at[0],
                r[1][0] * scale[0],
                r[1][1] * scale[1],
                r[1][2] * scale[2],
                at[1],
                r[2][0] * scale[0],
                r[2][1] * scale[1],
                r[2][2] * scale[2],
                at[2],
            ],
        }
    }

    fn rooms(clearance: &Clearance) -> impl Iterator<Item = f64> + '_ {
        clearance
            .edges
            .iter()
            .chain(&clearance.low)
            .chain(&clearance.high)
            .copied()
    }

    fn studs_of(half: [f64; 2]) -> Vec<Affine> {
        let mut studs = Vec::new();
        let mut x = -half[0] + 10.0;
        while x < half[0] {
            let mut z = -half[1] + 10.0;
            while z < half[1] {
                studs.push(placed(x, 0.0, z, false));
                z += 20.0;
            }
            x += 20.0;
        }
        studs
    }

    #[test]
    fn a_witness_certified_at_both_end_heights_blocks_every_height_between() {
        let opacity = Opacity::new([CLEAR]);
        let mut scene = Scene { state: 2026 };
        let (mut spans, mut near_bound, mut middle_refusals) = (0, 0, 0);
        for _ in 0..WITNESS_SCENES {
            let mut t = Vec::new();
            let points = [0, 1, 2].map(|_| around(&mut scene, WITNESS_REACH_LDU));
            triangle(&mut t, points);
            let solids = [PartSolid::from_mesh(&mesh::build(&t, &[]))];
            let far = around(&mut scene, FAR_LDU);
            let stud = turned(&mut scene, [1.0; 3], far);
            let frame = StudFrame::of(&stud);
            let scale = match scene.next(3) {
                0 => [1.0; 3],
                1 => [-1.0, 1.0, 1.0],
                _ => [STRETCH_X, 1.0, STRETCH_Z],
            };
            let offset = around(&mut scene, WITNESS_REACH_LDU);
            let at = [0, 1, 2].map(|axis| frame.base[axis] + offset[axis]);
            let witness = turned(&mut scene, scale, at);
            let instances = [CoverInstance {
                matrix: &witness,
                color: OPAQUE,
                part: 0,
                studs: &[],
            }];
            let boxes = [super::super::world_box(&instances[0], &solids[0])];
            let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
            let mut certifier = BelowCertifier::new(&model, STUD);
            certifier.radials = frame.radials();
            let below = BelowStud {
                frame,
                rotation: super::super::rotation_bits(&stud),
                owner: 0,
                coverer: 0,
            };
            for radial in 0..certifier.radials.len() {
                let first = radial * BELOW_HEIGHT_STEPS;
                let last = first + BELOW_HEIGHT_STEPS - 1;
                let fan = |index: usize| certifier.fan_at(&frame, index);
                for triangle in 0..solids[0].tree_points.len() {
                    let mut proof = Proof {
                        owner: 0,
                        slides: Vec::new(),
                        others: Vec::new(),
                        exact_rays: Vec::new(),
                    };
                    let unspanned = certifier.certify_across_heights(
                        &below,
                        first,
                        &[(0, triangle)],
                        &mut proof,
                        &mut Vec::new(),
                    );
                    let both = ALL_STEPS & !unspanned;
                    for step in (0..BELOW_ELEVATION_STEPS).filter(|step| both & (1 << step) != 0) {
                        spans += 1;
                        let [lowest, highest] = [first, last].map(|index| {
                            certifier
                                .cover(&fan(index), 0, triangle, 1 << step)
                                .expect("both end heights certify this step")
                                .1
                        });
                        let least = lowest.tightest(&highest);
                        let smallest = rooms(&least).fold(f64::INFINITY, f64::min);
                        near_bound += usize::from(smallest < NEAR_BOUND_LDU);
                        for index in first + 1..last {
                            let (origin, direction) =
                                certifier.ray(&frame, index * BELOW_ELEVATION_STEPS + step);
                            assert!(
                                model
                                    .search(&Segment::new(origin, direction, BELOW_REACH_LDU))
                                    .is_some(),
                                "fan {index}, step {step}: certified at both end heights but not blocked"
                            );
                            match certifier.cover(&fan(index), 0, triangle, 1 << step) {
                                Some((_, middle)) => assert!(
                                    rooms(&middle)
                                        .zip(rooms(&least))
                                        .all(|(room, end)| room >= end - AFFINE_SLACK_LDU),
                                    "fan {index}, step {step}: a clearance dips below both end heights"
                                ),
                                None => {
                                    assert!(smallest < AFFINE_SLACK_LDU);
                                    middle_refusals += 1;
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(
            spans > 1000 && near_bound > 10,
            "{spans} steps certified at both end heights, {near_bound} within {NEAR_BOUND_LDU} LDU of the bound"
        );
        assert_eq!(middle_refusals, 0);
    }

    #[test]
    fn a_witness_certified_at_two_elevations_blocks_every_elevation_between() {
        let opacity = Opacity::new([CLEAR]);
        let mut scene = Scene { state: 2027 };
        let (mut spans, mut near_bound, mut middle_refusals, mut stretched) = (0, 0, 0, 0);
        for _ in 0..WITNESS_SCENES {
            let mut t = Vec::new();
            let points = [0, 1, 2].map(|_| around(&mut scene, WITNESS_REACH_LDU));
            triangle(&mut t, points);
            let solids = [PartSolid::from_mesh(&mesh::build(&t, &[]))];
            let far = around(&mut scene, FAR_LDU);
            let stud = turned(&mut scene, [1.0; 3], far);
            let frame = StudFrame::of(&stud);
            let scale = match scene.next(3) {
                0 => [1.0; 3],
                1 => [-1.0, 1.0, 1.0],
                _ => [STRETCH_X, 1.0, STRETCH_Z],
            };
            let offset = around(&mut scene, WITNESS_REACH_LDU);
            let at = [0, 1, 2].map(|axis| frame.base[axis] + offset[axis]);
            let witness = turned(&mut scene, scale, at);
            let instances = [CoverInstance {
                matrix: &witness,
                color: OPAQUE,
                part: 0,
                studs: &[],
            }];
            let boxes = [super::super::world_box(&instances[0], &solids[0])];
            let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
            let mut certifier = BelowCertifier::new(&model, STUD);
            certifier.radials = frame.radials();
            for radial in 0..certifier.radials.len() {
                let first = radial * BELOW_HEIGHT_STEPS;
                for index in [first, first + BELOW_HEIGHT_STEPS - 1] {
                    let Some(prepared) = certifier.prepare(&certifier.fan_at(&frame, index), 0, 0)
                    else {
                        continue;
                    };
                    let slopes = &certifier.slopes;
                    let (claimed, recorded) = prepared.cover(slopes, ALL_STEPS);
                    let least_recorded = rooms(&recorded).fold(f64::INFINITY, f64::min);
                    for step in (0..BELOW_ELEVATION_STEPS).filter(|s| claimed & (1 << s) != 0) {
                        let (origin, direction) =
                            certifier.ray(&frame, index * BELOW_ELEVATION_STEPS + step);
                        assert!(
                            model
                                .search(&Segment::new(origin, direction, BELOW_REACH_LDU))
                                .is_some(),
                            "fan {index}, step {step}: claimed by a cover but not blocked"
                        );
                        match prepared.certify(slopes[step]) {
                            Some(own) => assert!(
                                rooms(&own)
                                    .zip(rooms(&recorded))
                                    .all(|(room, kept)| room >= kept - AFFINE_SLACK_LDU),
                                "fan {index}, step {step}: a cover records more room than the step has"
                            ),
                            None => assert!(least_recorded < AFFINE_SLACK_LDU),
                        }
                    }
                    let alone: u64 = (0..BELOW_ELEVATION_STEPS)
                        .filter(|&step| prepared.certify(slopes[step]).is_some())
                        .fold(0, |bits, step| bits | 1 << step);
                    if !prepared.rigid {
                        assert_eq!(claimed, alone);
                        stretched += alone.count_ones();
                        continue;
                    }
                    if alone.count_ones() < 2 || !prepared.keeps_depth_between() {
                        assert_eq!(claimed, alone);
                        continue;
                    }
                    let (low, high) = (
                        alone.trailing_zeros(),
                        u64::BITS - 1 - alone.leading_zeros(),
                    );
                    let between = (u64::MAX << low) & (u64::MAX >> (u64::BITS - 1 - high));
                    assert_eq!(claimed, between, "fan {index}: claims exactly the steps between the first and last that certify alone");
                    spans += 1;
                    near_bound += usize::from(least_recorded < NEAR_BOUND_LDU);
                    middle_refusals += (between & !alone).count_ones();
                }
            }
        }
        assert!(
            spans > 1000 && near_bound > 10 && stretched > 100,
            "{spans} spans, {near_bound} within {NEAR_BOUND_LDU} LDU of the bound, {stretched} stretched steps"
        );
        assert_eq!(middle_refusals, 0);
    }

    #[test]
    fn a_span_never_claims_an_elevation_too_close_to_the_face_to_certify() {
        let (low, middle, high) = (0, BELOW_ELEVATION_STEPS / 2, BELOW_ELEVATION_STEPS - 1);
        let opacity = Opacity::new([CLEAR]);
        let tilt = |y: f64| {
            let (rise, run) = (-BELOW_ELEVATION_STEP_DEGREES * (middle + 1) as f64)
                .to_radians()
                .sin_cos();
            let turn = (-(rise.atan2(run) + std::f64::consts::FRAC_PI_2)).sin_cos();
            Affine {
                m: [
                    turn.1, -turn.0, 0.0, 0.0, turn.0, turn.1, 0.0, y, 0.0, 0.0, 1.0, 0.0,
                ],
            }
        };
        let face_height = -10.0;
        let gap = FLOAT_ERROR_BOUND_LDU + 0.85 * HIT_EPSILON;
        let fan_origin = |stud: &Affine| {
            let frame = StudFrame::of(stud);
            let placeholder = [PartSolid::from_mesh(&mesh::build(&[], &[]))];
            let none: [CoverInstance; 0] = [];
            let empty = ModelSolids::new(&none, &[], &placeholder, &opacity);
            let mut probe = BelowCertifier::new(&empty, STUD);
            probe.radials = frame.radials();
            probe.fan_at(&frame, 0).origin
        };
        let unlifted = fan_origin(&tilt(0.0));
        let stud = tilt(face_height + gap - unlifted[1]);
        let origin = fan_origin(&stud);
        let [x, z] = [origin[0].round(), origin[2].round()];
        let mut t = Vec::new();
        triangle(
            &mut t,
            [
                [x - WITNESS_REACH_LDU, face_height, z - WITNESS_REACH_LDU],
                [x + WITNESS_REACH_LDU, face_height, z - WITNESS_REACH_LDU],
                [x, face_height, z + WITNESS_REACH_LDU],
            ],
        );
        let solids = [PartSolid::from_mesh(&mesh::build(&t, &[]))];
        let identity = Affine::IDENTITY;
        let instances = [CoverInstance {
            matrix: &identity,
            color: OPAQUE,
            part: 0,
            studs: &[],
        }];
        let boxes = [super::super::world_box(&instances[0], &solids[0])];
        let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
        let frame = StudFrame::of(&stud);
        let mut certifier = BelowCertifier::new(&model, STUD);
        certifier.radials = frame.radials();
        let prepared = certifier
            .prepare(&certifier.fan_at(&frame, 0), 0, 0)
            .expect("an opaque certifiable face");
        let slopes = &certifier.slopes;
        assert!(prepared.rigid);
        assert!(prepared.rigid_certify(slopes[low]).is_some());
        assert!(prepared.rigid_certify(slopes[high]).is_some());
        assert!(prepared.rigid_certify(slopes[middle]).is_none());
        assert!(!prepared.keeps_depth_between());
        let (covered, _) = prepared.cover(slopes, ALL_STEPS);
        assert_eq!(covered & (1 << middle), 0);
    }

    #[test]
    fn every_closed_below_verdict_equals_casting_every_ray() {
        let halves = [
            [200.0, 200.0],
            [20.0, 40.0],
            [10.0, 20.0],
            [10.0, 10.0],
            [20.0, 20.0],
            [20.0, 40.0],
            [20.0, 20.0],
        ];
        let solids = [
            shell(halves[0], 8.0, false, true),
            shell(halves[1], 8.0, false, true),
            shell(halves[2], 8.0, false, true),
            shell(halves[3], 24.0, false, false),
            shell(halves[4], 24.0, false, false),
            shell(halves[5], 24.0, true, false),
            gabled(halves[6], 24.0),
            tube(8.0, 24.0),
        ];
        let mut studs: Vec<Vec<Affine>> = halves.iter().map(|half| studs_of(*half)).collect();
        studs.push(Vec::new());
        let (mut closed, mut open, mut reused, mut unusual) = (0, 0, 0, 0);
        let mut under_squeezed_gable = 0;
        let (mut with_slides, mut with_anchors) = (false, false);
        for seed in 0..=SCENES {
            let far = if seed == SCENES {
                BEYOND_BOUNDED_LDU
            } else {
                0.0
            };
            let mut scene = Scene { state: seed };
            let mut parts = vec![(0, OPAQUE, placed(far, 0.0, 0.0, false))];
            let lone = [far - 150.0 + 20.0 * seed as f64, 48.0, 150.0];
            parts.push((1, OPAQUE, placed(lone[0], lone[1], lone[2], false)));
            parts.push((
                6,
                OPAQUE,
                placed(lone[0], lone[1] + 24.0, lone[2] + 20.0, false),
            ));
            let squeezed_lone = [lone[0], lone[1], lone[2] + 120.0];
            parts.push((
                1,
                OPAQUE,
                placed(squeezed_lone[0], squeezed_lone[1], squeezed_lone[2], false),
            ));
            let squeezed_gable = parts.len();
            parts.push((
                6,
                OPAQUE,
                squeezed(
                    squeezed_lone[0],
                    squeezed_lone[1] + 24.0,
                    squeezed_lone[2] + 25.0,
                ),
            ));
            let coverers_here = if seed == SCENES { 0 } else { COVERERS };
            for _ in 0..coverers_here {
                let owner = 1 + scene.next(2) as usize;
                let lift = [8.0, 8.0, 16.0, 48.0][scene.next(4) as usize];
                let quarter = scene.next(2) == 0;
                let [x, z] = [far, 0.0].map(|origin| origin + 20.0 * (scene.next(8) as f64 - 4.0));
                let stud_index = scene.next(studs[owner].len() as u64) as usize;
                let coverer = 3 + scene.next(4) as usize;
                let shift = [0, 1].map(|_| 10.0 * scene.next(3) as f64 - 10.0);
                let coverer_pose = scene.next(4);
                let color = if scene.next(10) == 0 { CLEAR } else { OPAQUE };
                let with_tube = scene.next(3) == 0;
                let copy = 120.0 * (scene.next(2) as f64 + 1.0);
                for offset in [0.0, copy] {
                    let at = placed(x + offset, lift, z, quarter);
                    let stud = at.then(&studs[owner][stud_index]);
                    let base = [stud.m[3], stud.m[7], stud.m[11]];
                    parts.push((owner, OPAQUE, at));
                    let [cx, cy, cz] = [base[0] + shift[0], base[1] + 24.0, base[2] + shift[1]];
                    let pose = match coverer_pose {
                        0 => placed(cx, cy, cz, false),
                        1 => placed(cx, cy, cz, true),
                        2 => mirrored(cx, cy, cz),
                        _ => stretched(cx, cy, cz),
                    };
                    parts.push((coverer, color, pose));
                    if with_tube {
                        parts.push((
                            7,
                            OPAQUE,
                            placed(base[0] + 20.0, base[1] - 4.0, base[2], false),
                        ));
                    }
                }
            }
            let instances: Vec<CoverInstance> = parts
                .iter()
                .map(|(part, color, matrix)| CoverInstance {
                    matrix,
                    color: *color,
                    part: *part,
                    studs: &studs[*part],
                })
                .collect();
            let opacity = Opacity::new([CLEAR]);
            let boxes: Vec<[Vec3; 2]> = instances
                .iter()
                .map(|instance| super::super::world_box(instance, &solids[instance.part]))
                .collect();
            let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
            let mut coverers = Coverers::new(&model, STUD);
            let mut below = BelowCertifier::new(&model, STUD);
            let mut reference = BelowCertifier::new(&model, STUD);
            for (owner, instance) in instances.iter().enumerate() {
                for stud_matrix in instance.studs {
                    let world = instance.matrix.then(stud_matrix);
                    let frame = StudFrame::of(&world);
                    let Some((_, coverer)) = coverers.covers(frame, Some(owner)) else {
                        continue;
                    };
                    let stud = BelowStud {
                        frame,
                        rotation: super::super::rotation_bits(&world),
                        owner,
                        coverer,
                    };
                    unusual += usize::from(instances[coverer].matrix.m[0] != 1.0);
                    under_squeezed_gable += usize::from(coverer == squeezed_gable);
                    reference.radials = frame.radials();
                    let rays = reference.radials.len() * RAYS_PER_RADIAL;
                    let every_ray = (0..rays).all(|index| {
                        let (origin, direction) = reference.ray(&frame, index);
                        model
                            .search(&Segment::new(origin, direction, BELOW_REACH_LDU))
                            .is_some()
                    });
                    below.radials = frame.radials();
                    if let Some(verdict) = below
                        .setting(&stud)
                        .and_then(|setting| below.reuse(&setting, &stud))
                    {
                        assert_eq!(verdict, every_ray, "reused, scene {seed}, owner {owner}");
                        reused += 1;
                    }
                    assert_eq!(
                        below.closed(&stud),
                        every_ray,
                        "scene {seed}, owner {owner}"
                    );
                    assert_eq!(
                        BelowCertifier::new(&model, STUD).closed(&stud),
                        every_ray,
                        "scene {seed}, owner {owner}, with no history"
                    );
                    if every_ray {
                        closed += 1;
                    } else {
                        open += 1;
                    }
                }
            }
            for certificate in below.certificates.values().flatten() {
                with_slides |= !certificate.slides.is_empty();
                with_anchors |= !certificate.anchors.is_empty();
            }
        }
        assert!(
            closed > 20 && open > 20 && reused > 10 && unusual > 20,
            "{closed} closed, {open} open, {reused} reused, {unusual} turned, mirrored or stretched"
        );
        assert!(
            with_slides && with_anchors,
            "certificates slide an owner and anchor others"
        );
        assert!(
            under_squeezed_gable > 0,
            "the z-squeezed gable covers a stud, so its contact form decides rays"
        );
    }

    struct PinnedLibrary(HashMap<String, String>);

    impl crate::flatten::Library for PinnedLibrary {
        fn source(&self, path: &str) -> Option<&str> {
            self.0.get(path).map(String::as_str)
        }
    }

    fn pinned_library() -> PinnedLibrary {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.cache/ldraw");
        let mut files = HashMap::new();
        let mut directories = vec![root.clone()];
        while let Some(directory) = directories.pop() {
            for entry in std::fs::read_dir(&directory).expect(
                "pinned LDraw inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`",
            ) {
                let path = entry.expect("pinned entry").path();
                if path.is_dir() {
                    directories.push(path);
                    continue;
                }
                let key = path
                    .strip_prefix(&root)
                    .expect("pinned file under the root")
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase();
                let bytes = std::fs::read(&path).expect("pinned file is readable");
                files.insert(key, String::from_utf8_lossy(&bytes).into_owned());
            }
        }
        PinnedLibrary(files)
    }

    #[test]
    fn a_custom_build_of_real_parts_hides_exactly_what_casting_every_ray_hides() {
        let library = pinned_library();
        let options = crate::compile::CompileOptions {
            lod: crate::flatten::Lod::Standard,
            stud_primitives: vec!["stud.dat".to_string(), "stud2.dat".to_string()],
            unofficial_allowlist: Vec::new(),
            rolling_mode: crate::compile::RollingMode::Skip,
        };
        let references = [
            "3958.dat",
            "3001.dat",
            "3010.dat",
            "3020.dat",
            "3623.dat",
            "3068b.dat",
            "3700.dat",
            "3039.dat",
            "3003.dat",
        ];
        let compiled: Vec<_> = references
            .iter()
            .map(|reference| {
                crate::compile::compile_part(&library, reference, &options).expect("part compiles")
            })
            .collect();
        let solids: Vec<PartSolid> = compiled
            .iter()
            .map(|part| PartSolid::from_mesh(&part.mesh))
            .collect();
        let studs: Vec<Vec<Affine>> = compiled
            .iter()
            .map(|part| part.studs.iter().map(|stud| stud.matrix).collect())
            .collect();
        let heights: Vec<f64> = compiled
            .iter()
            .map(|part| {
                let [min, max] = part.mesh.bounds().expect("part has geometry");
                f64::from(max[1] - min[1]).round()
            })
            .collect();
        let (mut closed, mut open) = (0, 0);
        for seed in 0..REAL_BUILDS {
            let mut scene = Scene { state: seed };
            let mut parts = vec![(0, OPAQUE, placed(0.0, 0.0, 0.0, false))];
            let mut level = [[0.0_f64; 6]; 6];
            for _ in 0..REAL_PARTS_PER_BUILD {
                let part = 1 + scene.next(references.len() as u64 - 1) as usize;
                let [i, j] = [0, 1].map(|_| scene.next(6) as usize);
                let floor = level[i][j];
                let top = floor + heights[part];
                let quarter = scene.next(2) == 0;
                let [x, z] = [i, j].map(|cell| 20.0 * cell as f64 - 50.0);
                let nudge = 10.0 * scene.next(2) as f64;
                parts.push((
                    part,
                    if scene.next(8) == 0 { CLEAR } else { OPAQUE },
                    placed(x + nudge, top, z, quarter),
                ));
                level[i][j] = top;
            }
            let instances: Vec<CoverInstance> = parts
                .iter()
                .map(|(part, color, matrix)| CoverInstance {
                    matrix,
                    color: *color,
                    part: *part,
                    studs: &studs[*part],
                })
                .collect();
            let opacity = Opacity::new([CLEAR]);
            let boxes: Vec<[Vec3; 2]> = instances
                .iter()
                .map(|instance| super::super::world_box(instance, &solids[instance.part]))
                .collect();
            let model = ModelSolids::new(&instances, &boxes, &solids, &opacity);
            let mut coverers = Coverers::new(&model, STUD);
            let mut below = BelowCertifier::new(&model, STUD);
            let mut reference = BelowCertifier::new(&model, STUD);
            for (owner, instance) in instances.iter().enumerate() {
                for stud_matrix in instance.studs {
                    let world = instance.matrix.then(stud_matrix);
                    let frame = StudFrame::of(&world);
                    let Some((_, coverer)) = coverers.covers(frame, Some(owner)) else {
                        continue;
                    };
                    let stud = BelowStud {
                        frame,
                        rotation: super::super::rotation_bits(&world),
                        owner,
                        coverer,
                    };
                    reference.radials = frame.radials();
                    let rays = reference.radials.len() * RAYS_PER_RADIAL;
                    let every_ray = (0..rays).all(|index| {
                        let (origin, direction) = reference.ray(&frame, index);
                        model
                            .search(&Segment::new(origin, direction, BELOW_REACH_LDU))
                            .is_some()
                    });
                    assert_eq!(
                        below.closed(&stud),
                        every_ray,
                        "build {seed}, owner {owner}"
                    );
                    assert_eq!(
                        BelowCertifier::new(&model, STUD).closed(&stud),
                        every_ray,
                        "build {seed}, owner {owner}, with no history"
                    );
                    if every_ray {
                        closed += 1;
                    } else {
                        open += 1;
                    }
                }
            }
        }
        assert!(closed > 10 && open > 5, "{closed} closed, {open} open");
    }
}
