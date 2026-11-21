use std::collections::{HashMap, VecDeque};

use crate::affine::{Affine, Vec3};
use crate::compile::CompileError;
use crate::flatten::{FlattenError, Flattened, Flattener, Library, Lod, StudReference, Triangle};
use crate::lattice::{describe_malformed, MalformedGeometry};
use crate::model::ModelInstance;
use crate::trig::{atan2, planar_length};

pub const CONTACT_OVERLAP_LDU: f64 = 2.0;
const VERTICAL_AXIS_MIN_COSINE: f64 = 0.999;
const HORIZONTAL_AXLE_MAX_SINE: f64 = 1e-3;
const PIN_CLEARANCE_LDU: f64 = 20.0;
const OBSOLETE_TITLE_MARK: &str = "(Obsolete)";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct VehicleSignatures {
    pub bogie_pivots: Vec<String>,
    pub pivot_pins: Vec<String>,
    pub wheelsets: Vec<String>,
    pub wheels: Vec<String>,
    pub couplers: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RailHeadBand {
    pub rail_part: String,
    pub inner: f64,
    pub outer: f64,
}

impl RailHeadBand {
    pub fn from_decimals(rail_part: &str, inner: &str, outer: &str) -> Result<Self, String> {
        let ldu = |text: &str| {
            text.parse::<f64>()
                .ok()
                .filter(|value| value.is_finite())
                .ok_or_else(|| format!("rail {rail_part}: {text:?} is not a decimal LDU value"))
        };
        Ok(RailHeadBand {
            rail_part: rail_part.to_string(),
            inner: ldu(inner)?,
            outer: ldu(outer)?,
        })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bogie {
    pub instances: Vec<usize>,
    pub pivot: Vec3,
    pub axles: Vec<Vec3>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Wheelset {
    pub instance: usize,
    pub centre: Vec3,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Coupler {
    pub instance: usize,
    pub face: Vec3,
    pub bogie: Option<usize>,
    pub obsolete_sources: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RailContact {
    pub rail_part: String,
    pub rail_top_y: f64,
    pub spread: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuideKind {
    BogiePivot,
    FixedAxle,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Vehicle {
    pub origin: [f64; 2],
    pub yaw: f64,
    pub body: Vec<usize>,
    pub bogies: Vec<Bogie>,
    pub fixed_axles: Vec<Vec3>,
    pub wheelsets: Vec<Wheelset>,
    pub guide_kind: GuideKind,
    pub guides: [f64; 2],
    pub front_coupler: Option<Coupler>,
    pub rear_coupler: Option<Coupler>,
    pub rail_contacts: Vec<RailContact>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum VehicleError {
    Flatten(FlattenError),
    Malformed { findings: Vec<MalformedGeometry> },
    PinCount { part: String, pins: usize },
    PinNotVertical { part: String },
    WheelCount { part: String, wheels: usize },
    AxleNotHorizontal { part: String },
    BogieWithoutAxle { instance: usize },
    UnsupportedRunningGear { bogies: usize, fixed_axles: usize },
    DuplicateCoupler { instance: usize },
}

impl std::fmt::Display for VehicleError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VehicleError::Flatten(error) => write!(f, "vehicle geometry: {error:?}"),
            VehicleError::Malformed { findings } => {
                write!(f, "vehicle geometry: {}", describe_malformed(findings))
            }
            VehicleError::PinCount { part, pins } => {
                write!(f, "bogie pivot {part} has {pins} pins, expected 1")
            }
            VehicleError::PinNotVertical { part } => {
                write!(f, "bogie pivot {part} is placed with its pin off vertical")
            }
            VehicleError::WheelCount { part, wheels } => {
                write!(f, "wheelset {part} has {wheels} wheels, expected 2")
            }
            VehicleError::AxleNotHorizontal { part } => {
                write!(f, "wheelset {part} is placed with its axle off horizontal")
            }
            VehicleError::BogieWithoutAxle { instance } => {
                write!(f, "bogie at instance {instance} carries no wheelset")
            }
            VehicleError::UnsupportedRunningGear {
                bogies,
                fixed_axles,
            } => write!(
                f,
                "running gear with {bogies} bogies and {fixed_axles} fixed axles is not supported"
            ),
            VehicleError::DuplicateCoupler { instance } => {
                write!(f, "second coupler at the same end at instance {instance}")
            }
        }
    }
}

impl From<FlattenError> for VehicleError {
    fn from(error: FlattenError) -> Self {
        VehicleError::Flatten(error)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum GeometryError {
    Flatten(FlattenError),
    Malformed { findings: Vec<MalformedGeometry> },
}

impl From<FlattenError> for GeometryError {
    fn from(error: FlattenError) -> Self {
        GeometryError::Flatten(error)
    }
}

impl From<GeometryError> for VehicleError {
    fn from(error: GeometryError) -> Self {
        match error {
            GeometryError::Flatten(error) => VehicleError::Flatten(error),
            GeometryError::Malformed { findings } => VehicleError::Malformed { findings },
        }
    }
}

impl From<GeometryError> for CompileError {
    fn from(error: GeometryError) -> Self {
        match error {
            GeometryError::Flatten(error) => CompileError::Flatten(error),
            GeometryError::Malformed { findings } => CompileError::Malformed { findings },
        }
    }
}

type Bounds = [Vec3; 2];

fn ldraw_point_to_y_up(p: Vec3) -> Vec3 {
    Affine::LDRAW_TO_Y_UP.apply(p)
}

fn origin(matrix: &Affine) -> Vec3 {
    [matrix.m[3], matrix.m[7], matrix.m[11]]
}

fn rotate(matrix: &Affine, v: Vec3) -> Vec3 {
    let m = &matrix.m;
    [
        m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
        m[4] * v[0] + m[5] * v[1] + m[6] * v[2],
        m[8] * v[0] + m[9] * v[1] + m[10] * v[2],
    ]
}

fn sub(a: Vec3, b: Vec3) -> Vec3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

fn dot(a: Vec3, b: Vec3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

fn norm(v: Vec3) -> f64 {
    dot(v, v).sqrt()
}

fn scale(v: Vec3, s: f64) -> Vec3 {
    [v[0] * s, v[1] * s, v[2] * s]
}

fn lerp(a: Vec3, b: Vec3, t: f64) -> Vec3 {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

fn midpoint(a: Vec3, b: Vec3) -> Vec3 {
    lerp(a, b, 0.5)
}

struct PlanFrame {
    origin: [f64; 2],
    cos: f64,
    sin: f64,
}

impl PlanFrame {
    fn local(&self, p: Vec3) -> Vec3 {
        let dx = p[0] - self.origin[0];
        let dz = p[2] - self.origin[1];
        [
            dx * self.cos + dz * self.sin,
            p[1],
            -dx * self.sin + dz * self.cos,
        ]
    }
}

struct Geometry<'a, L: Library> {
    library: &'a L,
    bounds: HashMap<String, Bounds>,
    triangles: HashMap<String, Vec<Triangle>>,
}

impl<'a, L: Library> Geometry<'a, L> {
    fn new(library: &'a L) -> Self {
        Geometry::with_bounds(library, HashMap::new())
    }

    fn with_bounds(library: &'a L, bounds: HashMap<String, Bounds>) -> Self {
        Geometry {
            library,
            bounds,
            triangles: HashMap::new(),
        }
    }

    fn path(&self, part: &str) -> Result<String, FlattenError> {
        Flattener::new(self.library, Lod::Standard, &[])
            .resolve(part)
            .ok_or_else(|| FlattenError::Unresolved {
                reference: part.to_string(),
                from: String::new(),
            })
    }

    fn flatten(&self, part: &str, targets: &[String]) -> Result<Flattened, GeometryError> {
        let path = self.path(part)?;
        let mut flattener = Flattener::new(self.library, Lod::Standard, targets);
        let flattened = flattener.flatten(&path)?;
        if flattener.malformed().is_empty() {
            Ok(flattened)
        } else {
            Err(GeometryError::Malformed {
                findings: flattener.malformed().to_vec(),
            })
        }
    }

    fn triangles(&mut self, part: &str) -> Result<&[Triangle], GeometryError> {
        if !self.triangles.contains_key(part) {
            let flattened = self.flatten(part, &[])?;
            self.triangles.insert(part.to_string(), flattened.triangles);
        }
        Ok(self
            .triangles
            .get(part)
            .map(Vec::as_slice)
            .unwrap_or_default())
    }

    fn bounds(&mut self, part: &str) -> Result<Bounds, GeometryError> {
        if let Some(bounds) = self.bounds.get(part) {
            return Ok(*bounds);
        }
        let bounds = triangle_bounds(self.triangles(part)?);
        self.bounds.insert(part.to_string(), bounds);
        Ok(bounds)
    }

    fn obsolete_sources(&self, part: &str) -> Result<Vec<String>, GeometryError> {
        Ok(self
            .flatten(part, &[])?
            .files
            .into_iter()
            .filter(|file| file.header.title.contains(OBSOLETE_TITLE_MARK))
            .map(|file| file.path)
            .collect())
    }

    fn placements(
        &self,
        part: &str,
        targets: &[String],
    ) -> Result<Vec<StudReference>, GeometryError> {
        Ok(self.flatten(part, targets)?.studs)
    }
}

fn triangle_bounds(triangles: &[Triangle]) -> Bounds {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for triangle in triangles {
        for point in triangle.points {
            let p = ldraw_point_to_y_up(point);
            for axis in 0..3 {
                min[axis] = min[axis].min(p[axis]);
                max[axis] = max[axis].max(p[axis]);
            }
        }
    }
    [min, max].map(|corner| corner.map(|v| v + 0.0))
}

pub fn part_bounds<L: Library>(library: &L, part: &str) -> Result<[Vec3; 2], GeometryError> {
    Geometry::new(library).bounds(part)
}

fn world_bounds(matrix: &Affine, local: Bounds) -> Bounds {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for corner in 0..8 {
        let p = [
            local[corner & 1][0],
            local[(corner >> 1) & 1][1],
            local[(corner >> 2) & 1][2],
        ];
        let w = matrix.apply(p);
        for axis in 0..3 {
            min[axis] = min[axis].min(w[axis]);
            max[axis] = max[axis].max(w[axis]);
        }
    }
    [min, max]
}

fn in_contact(a: &Bounds, b: &Bounds) -> bool {
    (0..3).all(|axis| a[1][axis].min(b[1][axis]) - a[0][axis].max(b[0][axis]) > CONTACT_OVERLAP_LDU)
}

fn contact_graph(bounds: &[Bounds]) -> Vec<Vec<usize>> {
    let mut neighbours = vec![Vec::new(); bounds.len()];
    for i in 0..bounds.len() {
        for j in (i + 1)..bounds.len() {
            if in_contact(&bounds[i], &bounds[j]) {
                neighbours[i].push(j);
                neighbours[j].push(i);
            }
        }
    }
    neighbours
}

fn component(
    seed: usize,
    neighbours: &[Vec<usize>],
    admit: impl Fn(usize) -> bool,
    seen: &mut [bool],
) -> Vec<usize> {
    let mut members = vec![seed];
    let mut queue = VecDeque::from([seed]);
    seen[seed] = true;
    while let Some(current) = queue.pop_front() {
        for &next in &neighbours[current] {
            if !seen[next] && admit(next) {
                seen[next] = true;
                members.push(next);
                queue.push_back(next);
            }
        }
    }
    members.sort_unstable();
    members
}

struct Axle {
    instance: usize,
    centre: Vec3,
    contact_radii: Vec<f64>,
}

fn clip_slab(polygon: Vec<Vec3>, along: impl Fn(Vec3) -> f64, keep_above: f64) -> Vec<Vec3> {
    let mut out = Vec::with_capacity(polygon.len() + 2);
    for (i, &current) in polygon.iter().enumerate() {
        let next = polygon[(i + 1) % polygon.len()];
        let a = along(current) - keep_above;
        let b = along(next) - keep_above;
        if a >= 0.0 {
            out.push(current);
        }
        if (a >= 0.0) != (b >= 0.0) {
            out.push(lerp(current, next, a / (a - b)));
        }
    }
    out
}

fn contact_radius(
    triangles: &[Vec3],
    centre: Vec3,
    axis: Vec3,
    lateral_from: f64,
    lateral_to: f64,
) -> f64 {
    let lateral = |p: Vec3| dot(sub(p, centre), axis);
    let mut radius: f64 = 0.0;
    for triangle in triangles.as_chunks::<3>().0 {
        let lower = clip_slab(triangle.to_vec(), lateral, lateral_from);
        let band = clip_slab(lower, |p| -lateral(p), -lateral_to);
        for p in band {
            let offset = sub(p, centre);
            let radial = sub(offset, scale(axis, dot(offset, axis)));
            radius = radius.max(norm(radial));
        }
    }
    radius
}

fn measure_axle<L: Library>(
    geometry: &mut Geometry<L>,
    instance: usize,
    placed: &ModelInstance,
    signatures: &VehicleSignatures,
    rails: &[RailHeadBand],
) -> Result<Axle, VehicleError> {
    let wheels = geometry.placements(&placed.part, &signatures.wheels)?;
    let [left, right] = wheels.as_slice() else {
        return Err(VehicleError::WheelCount {
            part: placed.part.clone(),
            wheels: wheels.len(),
        });
    };
    let wheel_origin = |wheel: &StudReference| {
        placed
            .matrix
            .apply(ldraw_point_to_y_up(origin(&wheel.matrix)))
    };
    let (a, b) = (wheel_origin(left), wheel_origin(right));
    let centre = midpoint(a, b);
    let span = sub(b, a);
    let axis = scale(span, 1.0 / norm(span));
    if axis[1].abs() > HORIZONTAL_AXLE_MAX_SINE {
        return Err(VehicleError::AxleNotHorizontal {
            part: placed.part.clone(),
        });
    }
    let mut wheel_triangles: Vec<(f64, Vec<Vec3>)> = Vec::new();
    for wheel in [left, right] {
        let side = dot(sub(wheel_origin(wheel), centre), axis).signum();
        let triangles = geometry.triangles(&wheel.primitive)?;
        let points = triangles
            .iter()
            .flat_map(|t| t.points)
            .map(|p| {
                placed
                    .matrix
                    .apply(ldraw_point_to_y_up(wheel.matrix.apply(p)))
            })
            .collect();
        wheel_triangles.push((side, points));
    }
    let contact_radii = rails
        .iter()
        .map(|rail| {
            wheel_triangles
                .iter()
                .map(|(side, points)| {
                    let (from, to) = if *side > 0.0 {
                        (rail.inner, rail.outer)
                    } else {
                        (-rail.outer, -rail.inner)
                    };
                    contact_radius(points, centre, axis, from, to)
                })
                .fold(0.0, f64::max)
        })
        .collect();
    Ok(Axle {
        instance,
        centre,
        contact_radii,
    })
}

struct Pivot {
    point: Vec3,
    plate_top: f64,
}

fn pivot_point<L: Library>(
    geometry: &mut Geometry<L>,
    placed: &ModelInstance,
    signatures: &VehicleSignatures,
) -> Result<Pivot, VehicleError> {
    let pins = geometry.placements(&placed.part, &signatures.pivot_pins)?;
    let [pin] = pins.as_slice() else {
        return Err(VehicleError::PinCount {
            part: placed.part.clone(),
            pins: pins.len(),
        });
    };
    let pin_axis = rotate(
        &placed.matrix,
        ldraw_point_to_y_up(rotate(&pin.matrix, [0.0, 1.0, 0.0])),
    );
    if pin_axis[1].abs() / norm(pin_axis) < VERTICAL_AXIS_MIN_COSINE {
        return Err(VehicleError::PinNotVertical {
            part: placed.part.clone(),
        });
    }
    let point = placed
        .matrix
        .apply(ldraw_point_to_y_up(origin(&pin.matrix)));
    let plate_top = geometry
        .triangles(&placed.part)?
        .iter()
        .flat_map(|t| t.points)
        .map(|p| placed.matrix.apply(ldraw_point_to_y_up(p)))
        .filter(|p| planar_length(p[0] - point[0], p[2] - point[2]) > PIN_CLEARANCE_LDU)
        .map(|p| p[1])
        .fold(f64::NEG_INFINITY, f64::max);
    Ok(Pivot { point, plate_top })
}

fn is_one_of(part: &str, names: &[String]) -> bool {
    names.iter().any(|name| name == part)
}

struct Guides {
    kind: GuideKind,
    front: Vec3,
    rear: Vec3,
}

fn choose_guides(pivots: &[Vec3], fixed: &[&Axle]) -> Result<Guides, VehicleError> {
    let ordered = |a: Vec3, b: Vec3| {
        if (a[0], a[2]) >= (b[0], b[2]) {
            (a, b)
        } else {
            (b, a)
        }
    };
    match (pivots, fixed) {
        ([a, b], []) => {
            let (front, rear) = ordered(*a, *b);
            Ok(Guides {
                kind: GuideKind::BogiePivot,
                front,
                rear,
            })
        }
        ([], [first, .., last]) => {
            let (front, rear) = ordered(first.centre, last.centre);
            let direction = sub(front, rear);
            let projection = |p: Vec3| dot(p, direction);
            let most = |better: fn(f64, f64) -> bool| {
                fixed
                    .iter()
                    .map(|axle| axle.centre)
                    .reduce(|best, p| {
                        if better(projection(p), projection(best)) {
                            p
                        } else {
                            best
                        }
                    })
                    .unwrap_or(front)
            };
            Ok(Guides {
                kind: GuideKind::FixedAxle,
                front: most(|a, b| a > b),
                rear: most(|a, b| a < b),
            })
        }
        _ => Err(VehicleError::UnsupportedRunningGear {
            bogies: pivots.len(),
            fixed_axles: fixed.len(),
        }),
    }
}

fn coupler_face(points: &[Vec3], front: bool) -> Vec3 {
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for p in points {
        for axis in 0..3 {
            min[axis] = min[axis].min(p[axis]);
            max[axis] = max[axis].max(p[axis]);
        }
    }
    [
        if front { max[0] } else { min[0] },
        (min[1] + max[1]) / 2.0,
        (min[2] + max[2]) / 2.0,
    ]
}

pub fn detect_vehicles<L: Library>(
    library: &L,
    instances: &[ModelInstance],
    signatures: &VehicleSignatures,
    rails: &[RailHeadBand],
) -> Result<Vec<Vehicle>, VehicleError> {
    detect_vehicles_with_bounds(library, instances, signatures, rails, HashMap::new())
}

pub fn detect_vehicles_with_bounds<L: Library>(
    library: &L,
    instances: &[ModelInstance],
    signatures: &VehicleSignatures,
    rails: &[RailHeadBand],
    known_bounds: HashMap<String, [Vec3; 2]>,
) -> Result<Vec<Vehicle>, VehicleError> {
    let mut geometry = Geometry::with_bounds(library, known_bounds);
    let mut bounds = Vec::with_capacity(instances.len());
    for placed in instances {
        bounds.push(world_bounds(&placed.matrix, geometry.bounds(&placed.part)?));
    }
    let neighbours = contact_graph(&bounds);
    let mut seen = vec![false; instances.len()];
    let mut vehicles = Vec::new();
    for seed in 0..instances.len() {
        if seen[seed] {
            continue;
        }
        let members = component(seed, &neighbours, |_| true, &mut seen);
        if !members
            .iter()
            .any(|&i| is_one_of(&instances[i].part, &signatures.wheelsets))
        {
            continue;
        }
        vehicles.push(analyse(
            &mut geometry,
            instances,
            &bounds,
            &neighbours,
            &members,
            signatures,
            rails,
        )?);
    }
    Ok(vehicles)
}

fn analyse<L: Library>(
    geometry: &mut Geometry<L>,
    instances: &[ModelInstance],
    bounds: &[Bounds],
    neighbours: &[Vec<usize>],
    members: &[usize],
    signatures: &VehicleSignatures,
    rails: &[RailHeadBand],
) -> Result<Vehicle, VehicleError> {
    let in_vehicle = |i: usize| members.binary_search(&i).is_ok();
    let mut axles = Vec::new();
    for &i in members {
        if is_one_of(&instances[i].part, &signatures.wheelsets) {
            axles.push(measure_axle(geometry, i, &instances[i], signatures, rails)?);
        }
    }
    let mut bogie_members: Vec<(Vec3, Vec<usize>)> = Vec::new();
    for &i in members {
        if !is_one_of(&instances[i].part, &signatures.bogie_pivots) {
            continue;
        }
        let Pivot { point, plate_top } = pivot_point(geometry, &instances[i], signatures)?;
        let mut seen = vec![false; instances.len()];
        let group = component(
            i,
            neighbours,
            |j| in_vehicle(j) && bounds[j][1][1] <= plate_top,
            &mut seen,
        );
        if !group.iter().any(|j| axles.iter().any(|a| a.instance == *j)) {
            return Err(VehicleError::BogieWithoutAxle { instance: i });
        }
        bogie_members.push((point, group));
    }
    let on_bogie = |i: usize| bogie_members.iter().any(|(_, g)| g.contains(&i));
    let fixed: Vec<&Axle> = axles.iter().filter(|a| !on_bogie(a.instance)).collect();
    let pivots: Vec<Vec3> = bogie_members.iter().map(|(p, _)| *p).collect();
    let guides = choose_guides(&pivots, &fixed)?;
    let forward = sub(guides.front, guides.rear);
    let yaw = atan2(forward[2], forward[0]);
    let centre = midpoint(guides.front, guides.rear);
    let plan_length = planar_length(forward[0], forward[2]);
    let frame = PlanFrame {
        origin: [centre[0], centre[2]],
        cos: forward[0] / plan_length,
        sin: forward[2] / plan_length,
    };
    let bogies = bogie_members
        .iter()
        .map(|(pivot, group)| Bogie {
            instances: group.clone(),
            pivot: frame.local(*pivot),
            axles: axles
                .iter()
                .filter(|a| group.contains(&a.instance))
                .map(|a| frame.local(a.centre))
                .collect(),
        })
        .collect();
    let mut front_coupler = None;
    let mut rear_coupler = None;
    for &i in members {
        if !is_one_of(&instances[i].part, &signatures.couplers) {
            continue;
        }
        let points: Vec<Vec3> = geometry
            .triangles(&instances[i].part)?
            .iter()
            .flat_map(|t| t.points)
            .map(|p| frame.local(instances[i].matrix.apply(ldraw_point_to_y_up(p))))
            .collect();
        let centroid_ahead = points.iter().map(|p| p[0]).sum::<f64>() > 0.0;
        let slot = if centroid_ahead {
            &mut front_coupler
        } else {
            &mut rear_coupler
        };
        if slot.is_some() {
            return Err(VehicleError::DuplicateCoupler { instance: i });
        }
        *slot = Some(Coupler {
            instance: i,
            face: coupler_face(&points, centroid_ahead),
            bogie: bogie_members.iter().position(|(_, g)| g.contains(&i)),
            obsolete_sources: geometry.obsolete_sources(&instances[i].part)?,
        });
    }
    let rail_contacts = rails
        .iter()
        .enumerate()
        .map(|(r, rail)| {
            let tops: Vec<f64> = axles
                .iter()
                .map(|a| a.centre[1] - a.contact_radii[r])
                .collect();
            let lowest = tops.iter().copied().fold(f64::INFINITY, f64::min);
            let highest = tops.iter().copied().fold(f64::NEG_INFINITY, f64::max);
            RailContact {
                rail_part: rail.rail_part.clone(),
                rail_top_y: lowest,
                spread: highest - lowest,
            }
        })
        .collect();
    let body = members.iter().copied().filter(|&i| !on_bogie(i)).collect();
    let half = norm([forward[0], 0.0, forward[2]]) / 2.0;
    Ok(Vehicle {
        origin: frame.origin,
        yaw,
        body,
        bogies,
        fixed_axles: fixed.iter().map(|a| frame.local(a.centre)).collect(),
        wheelsets: axles
            .iter()
            .map(|a| Wheelset {
                instance: a.instance,
                centre: frame.local(a.centre),
            })
            .collect(),
        guide_kind: guides.kind,
        guides: [half, -half],
        front_coupler,
        rear_coupler,
        rail_contacts,
    })
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::lattice::Malformation;
    use crate::trig::{cos, sin};

    struct Files(HashMap<String, String>);

    impl Library for Files {
        fn source(&self, path: &str) -> Option<&str> {
            self.0.get(path).map(String::as_str)
        }
    }

    #[test]
    fn vehicle_detection_refuses_a_part_with_malformed_geometry() {
        let part = |line: &str| {
            format!("0 Part\n0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt\n3 16 0 0 0 20 0 0 0 0 20\n{line}\n")
        };
        let library = Files(HashMap::from([
            (
                "parts/plate.dat".to_string(),
                part("3 16 0 0 0 1 0 0 0 0 1"),
            ),
            (
                "parts/sliver.dat".to_string(),
                part("3 16 0 0 0 40000000000000000 0 0 0 0 1"),
            ),
        ]));
        let signatures = VehicleSignatures {
            bogie_pivots: Vec::new(),
            pivot_pins: Vec::new(),
            wheelsets: Vec::new(),
            wheels: Vec::new(),
            couplers: Vec::new(),
        };
        let placed = |part: &str| ModelInstance {
            part: part.to_string(),
            inline: None,
            color: 16,
            matrix: Affine::IDENTITY,
            submodel: None,
        };
        assert_eq!(
            detect_vehicles(&library, &[placed("plate.dat")], &signatures, &[]),
            Ok(Vec::new())
        );
        assert_eq!(
            detect_vehicles(
                &library,
                &[placed("plate.dat"), placed("sliver.dat")],
                &signatures,
                &[]
            ),
            Err(VehicleError::Malformed {
                findings: vec![MalformedGeometry {
                    file: "parts/sliver.dat".to_string(),
                    malformation: Malformation::Unresolvable,
                }],
            })
        );
    }

    #[test]
    fn contact_radius_of_a_cylinder_band_is_its_radius() {
        let radius = 21.0;
        let steps = 64;
        let mut triangles = Vec::new();
        for k in 0..steps {
            let a = k as f64 * std::f64::consts::TAU / steps as f64;
            let b = (k + 1) as f64 * std::f64::consts::TAU / steps as f64;
            let ring = |angle: f64, x: f64| [x, radius * cos(angle), radius * sin(angle)];
            triangles.extend([ring(a, 40.0), ring(b, 40.0), ring(b, 60.0)]);
            triangles.extend([ring(a, 40.0), ring(b, 60.0), ring(a, 60.0)]);
        }
        let measured = contact_radius(&triangles, [0.0; 3], [1.0, 0.0, 0.0], 46.9, 53.1);
        assert!((measured - radius).abs() < 1e-9);
        assert_eq!(
            contact_radius(&triangles, [0.0; 3], [1.0, 0.0, 0.0], 70.0, 80.0),
            0.0
        );
    }
}
