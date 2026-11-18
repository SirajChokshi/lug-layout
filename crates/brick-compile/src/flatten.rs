use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

use crate::affine::{Affine, Vec3};
use crate::lattice::{non_finite, record, unplaceable, Malformation, MalformedGeometry};
use crate::ldraw::{self, LdrawFile, Line, Winding};
use crate::license::{self, LicenseVerdict};

pub const INHERIT_COLOR: u32 = 16;
const MAX_DEPTH: usize = 64;

pub trait Library {
    fn source(&self, path: &str) -> Option<&str>;

    fn parsed(&self, path: &str) -> Option<Rc<LdrawFile>> {
        self.source(path).map(|text| Rc::new(ldraw::parse(text)))
    }
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
    pub files: Vec<VisitedFile>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FlattenError {
    Unresolved { reference: String, from: String },
    TooDeep { path: String },
}

pub fn resolve_reference<L: Library + ?Sized>(
    library: &L,
    lod: Lod,
    reference: &str,
) -> Option<String> {
    let reference = ldraw::normalize_reference(reference);
    let low = format!("p/8/{reference}");
    let candidates = [
        (lod != Lod::Standard).then_some(low),
        Some(format!("parts/{reference}")),
        Some(format!("p/{reference}")),
        Some(reference.clone()),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| library.source(path).is_some())
}

pub struct Flattener<'a, L: Library> {
    library: &'a L,
    lod: Lod,
    stud_primitives: &'a [String],
    parsed: HashMap<String, Rc<LdrawFile>>,
    first_unresolved: Option<FlattenError>,
    root: String,
    malformed: Vec<MalformedGeometry>,
}

struct Frame {
    matrix: Affine,
    color: u32,
    flipped: bool,
    culling: bool,
    depth: usize,
}

impl<'a, L: Library> Flattener<'a, L> {
    pub fn new(library: &'a L, lod: Lod, stud_primitives: &'a [String]) -> Self {
        Flattener {
            library,
            lod,
            stud_primitives,
            parsed: HashMap::new(),
            first_unresolved: None,
            root: String::new(),
            malformed: Vec::new(),
        }
    }

    pub fn malformed(&self) -> &[MalformedGeometry] {
        &self.malformed
    }

    pub fn resolve(&self, reference: &str) -> Option<String> {
        resolve_reference(self.library, self.lod, reference)
    }

    fn load(&mut self, path: &str, out: &mut Flattened) -> Option<Rc<LdrawFile>> {
        if let Some(file) = self.parsed.get(path) {
            return Some(Rc::clone(file));
        }
        let file = self.parse(path)?;
        out.files.push(VisitedFile {
            path: path.to_string(),
            header: file.header.clone(),
            license: license::classify(file.header.license.as_deref()),
        });
        Some(file)
    }

    fn parse(&mut self, path: &str) -> Option<Rc<LdrawFile>> {
        if let Some(file) = self.parsed.get(path) {
            return Some(Rc::clone(file));
        }
        let file = self.library.parsed(path)?;
        self.parsed.insert(path.to_string(), Rc::clone(&file));
        Some(file)
    }

    pub fn closure(&mut self, reference: &str) -> Vec<String> {
        let mut queue: VecDeque<String> = self.resolve(reference).into_iter().collect();
        let mut seen: HashSet<String> = queue.iter().cloned().collect();
        let mut files = Vec::new();
        while let Some(path) = queue.pop_front() {
            let Some(file) = self.parse(&path) else {
                continue;
            };
            for line in &file.lines {
                let Line::Subfile { reference, .. } = line else {
                    continue;
                };
                if self.is_stud(reference) {
                    continue;
                }
                if let Some(child) = self.resolve(reference) {
                    if seen.insert(child.clone()) {
                        queue.push_back(child);
                    }
                }
            }
            files.push(path);
        }
        files
    }

    pub fn flatten(&mut self, path: &str) -> Result<Flattened, FlattenError> {
        self.first_unresolved = None;
        self.root = path.to_string();
        self.malformed.clear();
        let mut out = Flattened::default();
        let frame = Frame {
            matrix: Affine::IDENTITY,
            color: INHERIT_COLOR,
            flipped: false,
            culling: true,
            depth: 0,
        };
        let file = self
            .load(path, &mut out)
            .ok_or_else(|| FlattenError::Unresolved {
                reference: path.to_string(),
                from: String::new(),
            })?;
        let walked = self.walk(path, &file, &frame, &mut out);
        match (self.first_unresolved.take(), walked) {
            (Some(error), _) | (None, Err(error)) => Err(error),
            (None, Ok(())) => Ok(out),
        }
    }

    fn unresolved(&mut self, reference: &str, from: &str) {
        self.first_unresolved
            .get_or_insert_with(|| FlattenError::Unresolved {
                reference: reference.to_string(),
                from: from.to_string(),
            });
    }

    fn is_stud(&self, reference: &str) -> bool {
        self.stud_primitives.iter().any(|stud| stud == reference)
    }

    fn check_line(&mut self, path: &str, local: &[f64], placed: &[f64]) {
        if non_finite(local) {
            record(&mut self.malformed, path, Malformation::NonFinite);
        } else if let Some(malformation) = unplaceable(placed) {
            record(&mut self.malformed, &self.root, malformation);
        }
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
        if file.unparsed > 0 {
            record(&mut self.malformed, path, Malformation::Unparsed);
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
                    let stud = self.is_stud(reference);
                    let placed: &[f64] = if stud { &child_matrix.m } else { &[] };
                    self.check_line(path, &matrix.m, placed);
                    if stud {
                        out.studs.push(StudReference {
                            primitive: reference.clone(),
                            color: child_color,
                            matrix: child_matrix,
                        });
                        continue;
                    }
                    let Some(child_path) = self.resolve(reference) else {
                        self.unresolved(reference, path);
                        continue;
                    };
                    let Some(child) = self.load(&child_path, out) else {
                        self.unresolved(reference, path);
                        continue;
                    };
                    let child_frame = Frame {
                        matrix: child_matrix,
                        color: child_color,
                        flipped: frame.flipped ^ (matrix.determinant() < 0.0) ^ inverted,
                        culling: frame.culling && certified,
                        depth: frame.depth + 1,
                    };
                    self.walk(&child_path, &child, &child_frame, out)?;
                }
                Line::Edge { points } => {
                    let edge = points.map(|point| frame.matrix.apply(point));
                    self.check_line(path, points.as_flattened(), edge.as_flattened());
                    out.hard_edges.push(edge);
                }
                Line::Triangle { color, points } => {
                    let placed = points.map(|point| frame.matrix.apply(point));
                    self.check_line(path, points.as_flattened(), placed.as_flattened());
                    let culling = frame.culling && certified;
                    emit(out, frame, *color, culling, winding, *points);
                }
                Line::Quad { color, points } => {
                    let placed = points.map(|point| frame.matrix.apply(point));
                    self.check_line(path, points.as_flattened(), placed.as_flattened());
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
