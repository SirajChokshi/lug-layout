use std::collections::HashMap;
use std::rc::Rc;

use crate::affine::{Affine, Vec3};
use crate::ldraw::{self, LdrawFile, Line, Winding};
use crate::license::{self, LicenseVerdict};

pub const INHERIT_COLOR: u32 = 16;
const MAX_DEPTH: usize = 64;

pub trait Library {
    fn source(&self, path: &str) -> Option<&str>;
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Lod {
    #[default]
    Standard,
    Low,
    Far,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Triangle {
    pub color: u32,
    pub points: [Vec3; 3],
    pub double_sided: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct StudReference {
    pub primitive: String,
    pub color: u32,
    pub matrix: Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ConnectorReference {
    pub primitive: String,
    pub matrix: Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct VisitedFile {
    pub path: String,
    pub header: ldraw::Header,
    pub license: LicenseVerdict,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Flattened {
    pub triangles: Vec<Triangle>,
    pub hard_edges: Vec<[Vec3; 2]>,
    pub studs: Vec<StudReference>,
    pub technic_holes: Vec<ConnectorReference>,
    pub technic_pins: Vec<ConnectorReference>,
    pub technic_pin_bounds: Vec<Option<[Vec3; 2]>>,
    pub body_bounds: Option<[Vec3; 2]>,
    pub files: Vec<VisitedFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlattenError {
    Unresolved { reference: String, from: String },
    TooDeep { path: String },
}

pub struct Flattener<'a, L: Library> {
    library: &'a L,
    lod: Lod,
    stud_primitives: &'a [String],
    technic_hole_primitives: &'a [String],
    technic_pin_primitives: &'a [String],
    parsed: HashMap<String, Rc<LdrawFile>>,
}

struct Frame {
    matrix: Affine,
    color: u32,
    flipped: bool,
    culling: bool,
    technic_pin: Option<usize>,
    depth: usize,
}

impl<'a, L: Library> Flattener<'a, L> {
    pub fn new(library: &'a L, lod: Lod, stud_primitives: &'a [String]) -> Self {
        Flattener {
            library,
            lod,
            stud_primitives,
            technic_hole_primitives: &[],
            technic_pin_primitives: &[],
            parsed: HashMap::new(),
        }
    }

    pub fn with_technic_holes(mut self, technic_hole_primitives: &'a [String]) -> Self {
        self.technic_hole_primitives = technic_hole_primitives;
        self
    }

    pub fn with_technic_pins(mut self, technic_pin_primitives: &'a [String]) -> Self {
        self.technic_pin_primitives = technic_pin_primitives;
        self
    }

    pub fn resolve(&self, reference: &str) -> Option<String> {
        let reference = ldraw::normalize_reference(reference);
        let low = format!("p/8/{reference}");
        let candidates = [
            (self.lod != Lod::Standard).then_some(low),
            Some(format!("parts/{reference}")),
            Some(format!("p/{reference}")),
            Some(reference.clone()),
        ];
        candidates
            .into_iter()
            .flatten()
            .find(|path| self.library.source(path).is_some())
    }

    fn load(&mut self, path: &str, out: &mut Flattened) -> Option<Rc<LdrawFile>> {
        if let Some(file) = self.parsed.get(path) {
            return Some(Rc::clone(file));
        }
        let file = Rc::new(ldraw::parse(self.library.source(path)?));
        out.files.push(VisitedFile {
            path: path.to_string(),
            header: file.header.clone(),
            license: license::classify(file.header.license.as_deref()),
        });
        self.parsed.insert(path.to_string(), Rc::clone(&file));
        Some(file)
    }

    pub fn flatten(&mut self, path: &str) -> Result<Flattened, FlattenError> {
        let mut out = Flattened::default();
        let frame = Frame {
            matrix: Affine::IDENTITY,
            color: INHERIT_COLOR,
            flipped: false,
            culling: true,
            technic_pin: None,
            depth: 0,
        };
        let file = self
            .load(path, &mut out)
            .ok_or_else(|| FlattenError::Unresolved {
                reference: path.to_string(),
                from: String::new(),
            })?;
        self.walk(path, &file, &frame, &mut out)?;
        Ok(out)
    }

    fn is_stud(&self, reference: &str) -> bool {
        self.stud_primitives.iter().any(|stud| stud == reference)
    }

    fn walk(
        &mut self,
        path: &str,
        file: &LdrawFile,
        frame: &Frame,
        out: &mut Flattened,
    ) -> Result<(), FlattenError> {
        if frame.depth > MAX_DEPTH {
            return Err(FlattenError::TooDeep {
                path: path.to_string(),
            });
        }
        let mut certified = false;
        let mut winding = Winding::Ccw;
        let mut invert_next = false;
        for line in &file.lines {
            match line {
                Line::Certify(w) => {
                    certified = true;
                    winding = *w;
                }
                Line::NoCertify => certified = false,
                Line::SetWinding(w) => winding = *w,
                Line::InvertNext => invert_next = true,
                Line::Subfile {
                    color,
                    matrix,
                    reference,
                } => {
                    let child_color = resolve_color(*color, frame.color);
                    let child_matrix = frame.matrix.then(matrix);
                    let inverted = invert_next;
                    invert_next = false;
                    if self.is_stud(reference) {
                        out.studs.push(StudReference {
                            primitive: reference.clone(),
                            color: child_color,
                            matrix: child_matrix,
                        });
                        continue;
                    }
                    if self
                        .technic_hole_primitives
                        .iter()
                        .any(|hole| hole == reference)
                    {
                        out.technic_holes.push(ConnectorReference {
                            primitive: reference.clone(),
                            matrix: child_matrix,
                        });
                    }
                    let mut technic_pin = frame.technic_pin;
                    if technic_pin.is_none()
                        && self
                            .technic_pin_primitives
                            .iter()
                            .any(|pin| pin == reference)
                    {
                        technic_pin = Some(out.technic_pins.len());
                        out.technic_pins.push(ConnectorReference {
                            primitive: reference.clone(),
                            matrix: child_matrix,
                        });
                        out.technic_pin_bounds.push(None);
                    }
                    let child_path =
                        self.resolve(reference)
                            .ok_or_else(|| FlattenError::Unresolved {
                                reference: reference.clone(),
                                from: path.to_string(),
                            })?;
                    let child =
                        self.load(&child_path, out)
                            .ok_or_else(|| FlattenError::Unresolved {
                                reference: reference.clone(),
                                from: path.to_string(),
                            })?;
                    let child_frame = Frame {
                        matrix: child_matrix,
                        color: child_color,
                        flipped: frame.flipped ^ (matrix.determinant() < 0.0) ^ inverted,
                        culling: frame.culling && certified,
                        technic_pin,
                        depth: frame.depth + 1,
                    };
                    self.walk(&child_path, &child, &child_frame, out)?;
                }
                Line::Edge { points } => out
                    .hard_edges
                    .push([frame.matrix.apply(points[0]), frame.matrix.apply(points[1])]),
                Line::Triangle { color, points } => {
                    let culling = frame.culling && certified;
                    emit(out, frame, *color, culling, winding, *points);
                }
                Line::Quad { color, points } => {
                    let culling = frame.culling && certified;
                    emit(
                        out,
                        frame,
                        *color,
                        culling,
                        winding,
                        [points[0], points[1], points[2]],
                    );
                    emit(
                        out,
                        frame,
                        *color,
                        culling,
                        winding,
                        [points[0], points[2], points[3]],
                    );
                }
            }
        }
        Ok(())
    }
}

fn resolve_color(color: u32, inherited: u32) -> u32 {
    if color == INHERIT_COLOR {
        inherited
    } else {
        color
    }
}

fn emit(
    out: &mut Flattened,
    frame: &Frame,
    color: u32,
    culling: bool,
    winding: Winding,
    points: [Vec3; 3],
) {
    let transformed = [
        frame.matrix.apply(points[0]),
        frame.matrix.apply(points[1]),
        frame.matrix.apply(points[2]),
    ];
    let slot = match frame.technic_pin {
        Some(pin) => &mut out.technic_pin_bounds[pin],
        None => &mut out.body_bounds,
    };
    let mut bounds = slot.unwrap_or([transformed[0], transformed[0]]);
    for point in transformed {
        for axis in 0..3 {
            bounds[0][axis] = bounds[0][axis].min(point[axis]);
            bounds[1][axis] = bounds[1][axis].max(point[axis]);
        }
    }
    *slot = Some(bounds);
    let clockwise = (winding == Winding::Cw) ^ frame.flipped;
    let ordered = if clockwise {
        [transformed[0], transformed[2], transformed[1]]
    } else {
        transformed
    };
    out.triangles.push(Triangle {
        color: resolve_color(color, frame.color),
        points: ordered,
        double_sided: !culling,
    });
}
