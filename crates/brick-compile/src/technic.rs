use crate::sixteenths;
use std::f64::consts::PI;
use std::ops::Range;

use serde_json::{json, Value};

use crate::affine::{Affine, Vec3};
use crate::flatten::{ReferenceSpan, Triangle, VisitedFile};
use crate::trig::{cos, planar_length};

pub const STEPS_PER_LDU: i32 = sixteenths::PER_LDU;
const IDENTIFY_LDU: f64 = 0.0005;
const UNBOUNDED_STEPS: i32 = 1 << 20;
const DEGENERATE_LDU: f64 = 1e-9;
const STANDARD_SEGMENTS: f64 = 16.0;
const HIGH_SEGMENTS: f64 = 48.0;
const LOW_SEGMENTS: f64 = 8.0;
const CYLINDER_MARK: &str = "cyli";
const TECHNIC_ROLE: &str = "technic";
const PRIMITIVE_FOLDER: &str = "p/";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TechnicPrimitives {
    pub holes: Vec<String>,
    pub pins: Vec<String>,
    pub axle_ends: Vec<String>,
}

pub fn is_circular_primitive(reference: &str) -> bool {
    let name = reference.rsplit('/').next().unwrap_or(reference);
    let Some((numerator, rest)) = name.split_once('-') else {
        return false;
    };
    let denominator: String = rest.chars().take_while(char::is_ascii_digit).collect();
    !numerator.is_empty()
        && numerator.chars().all(|c| c.is_ascii_digit())
        && !denominator.is_empty()
        && rest[denominator.len()..].starts_with(|c: char| c.is_ascii_alphabetic())
}

impl TechnicPrimitives {
    pub fn from_table(table: &Value) -> Result<Self, String> {
        let mut out = TechnicPrimitives::default();
        let entries = table["primitives"]
            .as_array()
            .ok_or("primitive table: primitives must be an array")?;
        for entry in entries {
            let Some(role) = entry[TECHNIC_ROLE].as_str() else {
                continue;
            };
            let file = entry["file"]
                .as_str()
                .ok_or("primitive table: every entry needs a file")?;
            let name = file
                .strip_prefix(PRIMITIVE_FOLDER)
                .ok_or(format!(
                    "{file}: a Technic primitive lives in {PRIMITIVE_FOLDER}"
                ))?
                .to_string();
            match role {
                "hole" => out.holes.push(name),
                "pin" => out.pins.push(name),
                "axleEnd" => out.axle_ends.push(name),
                other => return Err(format!("{file}: unknown Technic role {other}")),
            }
        }
        Ok(out)
    }

    pub fn is_empty(&self) -> bool {
        self.holes.is_empty() && self.pins.is_empty() && self.axle_ends.is_empty()
    }

    pub fn appear_in(&self, files: &[VisitedFile]) -> bool {
        files.iter().any(|file| {
            file.path.starts_with(PRIMITIVE_FOLDER)
                && self
                    .names()
                    .any(|name| file.path.rsplit('/').next() == Some(name.as_str()))
        })
    }

    pub fn shape_reference(&self, reference: &str) -> bool {
        self.names().any(|name| name == reference) || is_circular_primitive(reference)
    }

    fn names(&self) -> impl Iterator<Item = &String> {
        self.holes.iter().chain(&self.pins).chain(&self.axle_ends)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Line {
    pub axis: usize,
    pub at: [i32; 2],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Profile {
    pub from: i32,
    pub radii: Vec<i32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hole {
    pub line: Line,
    pub profile: Profile,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pin {
    pub origin: i32,
    pub direction: i32,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Component {
    pub pin: Option<Pin>,
    pub profile: Profile,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Shaft {
    pub line: Line,
    pub components: Vec<Component>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TechnicPart {
    pub holes: Vec<Hole>,
    pub shaft: Option<Shaft>,
}

impl TechnicPart {
    pub fn is_empty(&self) -> bool {
        self.holes.is_empty() && self.shaft.is_none()
    }

    pub fn to_json(&self) -> Value {
        let profile = |p: &Profile| json!({ "from": p.from, "radii": p.radii });
        let holes: Vec<Value> = self
            .holes
            .iter()
            .map(|hole| {
                json!({
                    "axis": hole.line.axis,
                    "at": hole.line.at,
                    "from": hole.profile.from,
                    "radii": hole.profile.radii,
                })
            })
            .collect();
        let shaft = self.shaft.as_ref().map(|shaft| {
            let components: Vec<Value> = shaft
                .components
                .iter()
                .map(|component| {
                    let mut value = profile(&component.profile);
                    value["pin"] = component.pin.map_or(
                        Value::Null,
                        |pin| json!({ "origin": pin.origin, "direction": pin.direction }),
                    );
                    value
                })
                .collect();
            json!({ "axis": shaft.line.axis, "at": shaft.line.at, "components": components })
        });
        json!({ "stepsPerLdu": STEPS_PER_LDU, "holes": holes, "shaft": shaft })
    }
}

fn identify(v: f64) -> Option<i32> {
    let r = v.round();
    ((v - r).abs() <= IDENTIFY_LDU).then_some(r as i32)
}

fn identify_down(v: f64) -> i32 {
    identify(v).unwrap_or(v.floor() as i32)
}

fn identify_up(v: f64) -> i32 {
    identify(v).unwrap_or(v.ceil() as i32)
}

fn stepped(r: f64, outward: fn(f64) -> f64) -> i32 {
    if !r.is_finite() {
        return UNBOUNDED_STEPS;
    }
    let value =
        sixteenths::identified(r).unwrap_or_else(|| outward(r * f64::from(STEPS_PER_LDU)) as i32);
    value.min(UNBOUNDED_STEPS)
}

fn steps_up(r: f64) -> i32 {
    stepped(r, f64::ceil)
}

fn steps_down(r: f64) -> i32 {
    stepped(r, f64::floor)
}

fn column(m: &Affine, c: usize) -> Vec3 {
    [m.m[c], m.m[4 + c], m.m[8 + c]]
}

fn origin(m: &Affine) -> Vec3 {
    [m.m[3], m.m[7], m.m[11]]
}

fn length(v: Vec3) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

fn unit_axis(v: Vec3) -> Option<(usize, i32)> {
    let l = length(v);
    if l == 0.0 {
        return None;
    }
    let n = v.map(|c| c / l);
    let axis = (0..3).find(|&k| (n[k].abs() - 1.0).abs() <= IDENTIFY_LDU)?;
    let sideways = (0..3).all(|k| k == axis || n[k].abs() <= IDENTIFY_LDU);
    sideways.then_some((axis, if n[axis] > 0.0 { 1 } else { -1 }))
}

fn others(axis: usize) -> [usize; 2] {
    match axis {
        0 => [1, 2],
        1 => [0, 2],
        _ => [0, 1],
    }
}

fn radial(p: Vec3, line: Line) -> f64 {
    let [a, b] = others(line.axis);
    planar_length(p[a] - f64::from(line.at[0]), p[b] - f64::from(line.at[1]))
}

fn line_through(m: &Affine) -> Option<(Line, i32)> {
    let (axis, _) = unit_axis(column(m, 1))?;
    let o = origin(m);
    let [a, b] = others(axis);
    let line = Line {
        axis,
        at: [identify(o[a])?, identify(o[b])?],
    };
    Some((line, identify(o[axis])?))
}

fn on_line(m: &Affine, line: Line) -> bool {
    let Some((axis, _)) = unit_axis(column(m, 1)) else {
        return false;
    };
    let o = origin(m);
    let [a, b] = others(line.axis);
    axis == line.axis
        && (o[a] - f64::from(line.at[0])).abs() <= IDENTIFY_LDU
        && (o[b] - f64::from(line.at[1])).abs() <= IDENTIFY_LDU
}

fn vertices<'a>(
    triangles: &'a [Triangle],
    range: &Range<usize>,
) -> impl Iterator<Item = Vec3> + 'a {
    triangles[range.clone()]
        .iter()
        .flat_map(|triangle| triangle.points)
}

fn facing(span: &ReferenceSpan, triangles: &[Triangle]) -> Option<i32> {
    let (axis, _) = unit_axis(column(&span.matrix, 1))?;
    let o = origin(&span.matrix);
    let mut sum = 0.0;
    let mut count = 0.0;
    for p in vertices(triangles, &span.triangles) {
        sum += p[axis] - o[axis];
        count += 1.0;
    }
    if count == 0.0 || (sum / count).abs() <= IDENTIFY_LDU {
        return None;
    }
    Some(if sum > 0.0 { 1 } else { -1 })
}

fn segments(path: &str) -> f64 {
    if path.starts_with("p/48/") {
        HIGH_SEGMENTS
    } else if path.starts_with("p/8/") {
        LOW_SEGMENTS
    } else {
        STANDARD_SEGMENTS
    }
}

fn sagitta(span: &ReferenceSpan, triangles: &[Triangle]) -> f64 {
    let o = origin(&span.matrix);
    let y = column(&span.matrix, 1);
    let l = length(y);
    if l == 0.0 {
        return 0.0;
    }
    let y = y.map(|c| c / l);
    let mut reach: f64 = 0.0;
    for p in vertices(triangles, &span.triangles) {
        let d = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
        let along = d[0] * y[0] + d[1] * y[1] + d[2] * y[2];
        let off = [
            d[0] - along * y[0],
            d[1] - along * y[1],
            d[2] - along * y[2],
        ];
        reach = reach.max(length(off));
    }
    reach * (1.0 - cos(PI / segments(&span.path)))
}

fn slacks(triangles: &[Triangle], spans: &[ReferenceSpan], line: Line) -> Vec<f64> {
    let mut circular: Vec<&ReferenceSpan> = spans
        .iter()
        .filter(|span| is_circular_primitive(&span.reference))
        .collect();
    circular.sort_by_key(|span| std::cmp::Reverse(span.triangles.len()));
    let mut out = vec![0.0; triangles.len()];
    for span in circular {
        let slack = if on_line(&span.matrix, line) {
            0.0
        } else {
            sagitta(span, triangles)
        };
        for value in &mut out[span.triangles.clone()] {
            *value = slack;
        }
    }
    out
}

struct Cylinder {
    radius: f64,
    from: f64,
    to: f64,
    triangles: Range<usize>,
}

fn cylinder(span: &ReferenceSpan, triangles: &[Triangle], line: Line) -> Option<Cylinder> {
    let name = span.reference.rsplit('/').next().unwrap_or(&span.reference);
    if !is_circular_primitive(name) || !name.contains(CYLINDER_MARK) || !on_line(&span.matrix, line)
    {
        return None;
    }
    let x = column(&span.matrix, 0);
    let z = column(&span.matrix, 2);
    let radius = length(x);
    let round = (length(z) - radius).abs() <= IDENTIFY_LDU
        && x[line.axis].abs() <= IDENTIFY_LDU
        && z[line.axis].abs() <= IDENTIFY_LDU;
    if !round || span.triangles.is_empty() {
        return None;
    }
    let mut from = f64::INFINITY;
    let mut to = f64::NEG_INFINITY;
    for p in vertices(triangles, &span.triangles) {
        if (radial(p, line) - radius).abs() > IDENTIFY_LDU {
            return None;
        }
        from = from.min(p[line.axis]);
        to = to.max(p[line.axis]);
    }
    Some(Cylinder {
        radius,
        from,
        to,
        triangles: span.triangles.clone(),
    })
}

fn clip(points: &[Vec3], axis: usize, bound: f64, keep_above: bool) -> Vec<Vec3> {
    let inside = |p: &Vec3| {
        if keep_above {
            p[axis] >= bound
        } else {
            p[axis] <= bound
        }
    };
    let mut out = Vec::with_capacity(points.len() + 1);
    for (i, a) in points.iter().enumerate() {
        let b = &points[(i + 1) % points.len()];
        if inside(a) {
            out.push(*a);
        }
        if inside(a) != inside(b) {
            let t = (bound - a[axis]) / (b[axis] - a[axis]);
            out.push([0, 1, 2].map(|k| a[k] + (b[k] - a[k]) * t));
        }
    }
    out
}

fn slab(triangle: &Triangle, axis: usize, bin: i32) -> Option<Vec<Vec3>> {
    let lo = f64::from(bin);
    let piece = clip(
        &clip(&triangle.points, axis, lo, true),
        axis,
        lo + 1.0,
        false,
    );
    let (min, max) = piece
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), p| {
            (a.min(p[axis]), b.max(p[axis]))
        });
    (piece.len() >= 3 && max - min > DEGENERATE_LDU).then_some(piece)
}

fn segment_distance(a: [f64; 2], b: [f64; 2]) -> f64 {
    let d = [b[0] - a[0], b[1] - a[1]];
    let span = d[0] * d[0] + d[1] * d[1];
    let t = if span == 0.0 {
        0.0
    } else {
        (-(a[0] * d[0] + a[1] * d[1]) / span).clamp(0.0, 1.0)
    };
    planar_length(a[0] + d[0] * t, a[1] + d[1] * t)
}

fn polygon_distance(points: &[Vec3], line: Line) -> f64 {
    let [a, b] = others(line.axis);
    let flat: Vec<[f64; 2]> = points
        .iter()
        .map(|p| [p[a] - f64::from(line.at[0]), p[b] - f64::from(line.at[1])])
        .collect();
    let mut nearest = f64::INFINITY;
    let mut positive = false;
    let mut negative = false;
    for (i, p) in flat.iter().enumerate() {
        let q = flat[(i + 1) % flat.len()];
        nearest = nearest.min(segment_distance(*p, q));
        let cross = p[0] * q[1] - p[1] * q[0];
        positive |= cross > DEGENERATE_LDU;
        negative |= cross < -DEGENERATE_LDU;
    }
    let area: f64 = flat
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let q = flat[(i + 1) % flat.len()];
            p[0] * q[1] - p[1] * q[0]
        })
        .sum();
    if area.abs() > DEGENERATE_LDU && positive != negative {
        0.0
    } else {
        nearest
    }
}

fn axial_range(triangle: &Triangle, axis: usize) -> (f64, f64) {
    triangle
        .points
        .iter()
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| {
            (lo.min(p[axis]), hi.max(p[axis]))
        })
}

fn bins_of(triangle: &Triangle, axis: usize, from: i32, to: i32) -> Range<i32> {
    let (lo, hi) = axial_range(triangle, axis);
    (lo.floor() as i32).max(from)..(hi.ceil() as i32).min(to)
}

fn envelope(
    triangles: &[Triangle],
    members: impl Iterator<Item = usize>,
    slack: &[f64],
    line: Line,
    from: i32,
    to: i32,
) -> Profile {
    let mut reach = vec![0.0f64; usize::try_from(to - from).unwrap_or(0)];
    for i in members {
        let triangle = &triangles[i];
        for bin in bins_of(triangle, line.axis, from, to) {
            let Some(piece) = slab(triangle, line.axis, bin) else {
                continue;
            };
            let far = piece.iter().map(|p| radial(*p, line)).fold(0.0, f64::max) + slack[i];
            let slot = &mut reach[(bin - from) as usize];
            *slot = slot.max(far);
        }
    }
    Profile {
        from,
        radii: reach.into_iter().map(steps_up).collect(),
    }
}

fn void(
    triangles: &[Triangle],
    spans: &[ReferenceSpan],
    line: Line,
    from: i32,
    to: i32,
) -> Profile {
    let slack = slacks(triangles, spans, line);
    let mut free = vec![f64::INFINITY; usize::try_from(to - from).unwrap_or(0)];
    let mut bore = vec![false; triangles.len()];
    for cylinder in spans
        .iter()
        .filter_map(|span| cylinder(span, triangles, line))
    {
        for flag in &mut bore[cylinder.triangles.clone()] {
            *flag = true;
        }
        for bin in from..to {
            if cylinder.from < f64::from(bin + 1) && cylinder.to > f64::from(bin) {
                let slot = &mut free[(bin - from) as usize];
                *slot = slot.min(cylinder.radius);
            }
        }
    }
    for (i, triangle) in triangles.iter().enumerate() {
        if bore[i] {
            continue;
        }
        for bin in bins_of(triangle, line.axis, from, to) {
            let Some(piece) = slab(triangle, line.axis, bin) else {
                continue;
            };
            let near = polygon_distance(&piece, line) - slack[i];
            let slot = &mut free[(bin - from) as usize];
            *slot = slot.min(near);
        }
    }
    Profile {
        from,
        radii: free.into_iter().map(steps_down).collect(),
    }
}

struct End {
    line: Line,
    t: i32,
    inward: i32,
}

fn holes(
    triangles: &[Triangle],
    spans: &[ReferenceSpan],
    names: &[String],
    bounds: [Vec3; 2],
) -> Vec<Hole> {
    let ends: Vec<End> = spans
        .iter()
        .filter(|span| names.contains(&span.reference))
        .filter_map(|span| {
            let (line, t) = line_through(&span.matrix)?;
            let inward = facing(span, triangles)?;
            Some(End { line, t, inward })
        })
        .collect();
    let mut used = vec![false; ends.len()];
    let mut out = Vec::new();
    for (i, start) in ends.iter().enumerate() {
        if start.inward != 1 || used[i] {
            continue;
        }
        let partner = ends
            .iter()
            .enumerate()
            .filter(|(j, end)| {
                !used[*j] && end.inward == -1 && end.line == start.line && end.t > start.t
            })
            .min_by_key(|(_, end)| end.t);
        let Some((j, end)) = partner else {
            continue;
        };
        let axis = start.line.axis;
        let through =
            identify(bounds[0][axis]) == Some(start.t) && identify(bounds[1][axis]) == Some(end.t);
        if !through {
            continue;
        }
        let profile = void(triangles, spans, start.line, start.t, end.t);
        if profile.radii.iter().any(|&r| r <= 0) {
            continue;
        }
        used[i] = true;
        used[j] = true;
        out.push(Hole {
            line: start.line,
            profile,
        });
    }
    out
}

fn outermost<'a>(spans: &[&'a ReferenceSpan]) -> Vec<&'a ReferenceSpan> {
    spans
        .iter()
        .filter(|span| {
            !spans.iter().any(|other| {
                !std::ptr::eq(*other, **span)
                    && other.triangles.start <= span.triangles.start
                    && span.triangles.end <= other.triangles.end
                    && other.triangles.len() > span.triangles.len()
            })
        })
        .copied()
        .collect()
}

fn pin_component(
    span: &ReferenceSpan,
    triangles: &[Triangle],
    slack: &[f64],
    line: Line,
) -> Option<Component> {
    let (own, origin_t) = line_through(&span.matrix)?;
    let direction = facing(span, triangles)?;
    if own != line || span.triangles.is_empty() {
        return None;
    }
    let (lo, hi) = triangles[span.triangles.clone()]
        .iter()
        .map(|triangle| axial_range(triangle, line.axis))
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), (lo, hi)| {
            (a.min(lo), b.max(hi))
        });
    let origin = f64::from(origin_t);
    let (from, to) = if direction > 0 {
        if lo < origin - IDENTIFY_LDU {
            return None;
        }
        (origin_t, identify_up(hi))
    } else {
        if hi > origin + IDENTIFY_LDU {
            return None;
        }
        (identify_down(lo), origin_t)
    };
    Some(Component {
        pin: Some(Pin {
            origin: origin_t,
            direction,
        }),
        profile: envelope(triangles, span.triangles.clone(), slack, line, from, to),
    })
}

fn shaft(
    triangles: &[Triangle],
    spans: &[ReferenceSpan],
    primitives: &TechnicPrimitives,
) -> Option<Shaft> {
    let declaring: Vec<&ReferenceSpan> = spans
        .iter()
        .filter(|span| {
            primitives.pins.contains(&span.reference)
                || primitives.axle_ends.contains(&span.reference)
        })
        .collect();
    let (line, _) = line_through(&declaring.first()?.matrix)?;
    if !declaring
        .iter()
        .all(|span| line_through(&span.matrix).is_some_and(|(own, _)| own == line))
    {
        return None;
    }
    let slack = slacks(triangles, spans, line);
    let pins: Vec<&ReferenceSpan> = declaring
        .iter()
        .filter(|span| primitives.pins.contains(&span.reference))
        .copied()
        .collect();
    let mut claimed = vec![false; triangles.len()];
    let mut components = Vec::new();
    for span in outermost(&pins) {
        if let Some(component) = pin_component(span, triangles, &slack, line) {
            for flag in &mut claimed[span.triangles.clone()] {
                *flag = true;
            }
            components.push(component);
        }
    }
    let rest: Vec<usize> = (0..triangles.len()).filter(|&i| !claimed[i]).collect();
    if !rest.is_empty() {
        let (lo, hi) = rest
            .iter()
            .map(|&i| axial_range(&triangles[i], line.axis))
            .fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), (lo, hi)| {
                (a.min(lo), b.max(hi))
            });
        components.push(Component {
            pin: None,
            profile: envelope(
                triangles,
                rest.into_iter(),
                &slack,
                line,
                identify_down(lo),
                identify_up(hi),
            ),
        });
    }
    Some(Shaft { line, components })
}

pub fn analyze(
    triangles: &[Triangle],
    spans: &[ReferenceSpan],
    primitives: &TechnicPrimitives,
    bounds: [Vec3; 2],
) -> TechnicPart {
    let holes = holes(triangles, spans, &primitives.holes, bounds);
    let shaft = if holes.is_empty() {
        shaft(triangles, spans, primitives)
    } else {
        None
    };
    TechnicPart { holes, shaft }
}
