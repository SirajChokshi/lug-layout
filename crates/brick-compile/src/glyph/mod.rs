mod format;
mod outline;
mod raster;

use std::collections::{HashMap, HashSet};

use crate::affine::Affine;
use crate::compile::{compile_part, CompileError, CompileOptions, RollingMode};
use crate::flatten::{Library, Lod, StudReference, INHERIT_COLOR};
use crate::mesh::Mesh;
use crate::technic::TechnicPrimitives;

pub use self::format::GlyphFormatError;
use self::raster::{rasterize, PlanTriangles};

pub const GLYPH_MAGIC: &[u8; 8] = b"BRRGLYF1";
pub const PIXELS_PER_STUD: u32 = 8;
pub const SAMPLES_PER_PIXEL_SIDE: u32 = 4;
pub const MAX_SIDE_PIXELS: u32 = 16_383;
pub const MAX_PIXELS: u64 = 1 << 24;
pub const MAX_COLORS: usize = 1 << 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Glyph {
    pub origin: [i32; 2],
    pub width: u32,
    pub depth: u32,
    pub colors: Vec<u32>,
    pub coverage: Vec<u8>,
    pub color_index: Vec<u16>,
    pub outline: Vec<Vec<[u16; 2]>>,
}

impl Glyph {
    pub fn empty() -> Self {
        Glyph {
            origin: [0, 0],
            width: 0,
            depth: 0,
            colors: Vec::new(),
            coverage: Vec::new(),
            color_index: Vec::new(),
            outline: Vec::new(),
        }
    }

    pub fn pixel(&self, column: u32, row: u32) -> Option<(u8, u32)> {
        if column >= self.width || row >= self.depth {
            return None;
        }
        let at = column as usize + self.width as usize * row as usize;
        let coverage = self.coverage[at];
        (coverage > 0).then(|| (coverage, self.colors[self.color_index[at] as usize]))
    }

    pub fn covered_samples(&self) -> u64 {
        self.coverage.iter().map(|&count| u64::from(count)).sum()
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GlyphError {
    Unplaceable,
    TooLarge { width: u64, depth: u64 },
    TooTall { sixteenths: i64 },
    TooManyColors { colors: usize },
    UnknownStud { primitive: String },
}

impl std::fmt::Display for GlyphError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GlyphError::Unplaceable => {
                write!(f, "a glyph corner lies too far out to place on the glyph grid")
            }
            GlyphError::TooLarge { width, depth } => write!(
                f,
                "seen from above it spans {width} × {depth} glyph pixels, past the {MAX_SIDE_PIXELS} a side and {MAX_PIXELS} in all a glyph holds"
            ),
            GlyphError::TooTall { sixteenths } => write!(
                f,
                "its triangles seen from above span {sixteenths} sixteenths of an LDU in height, more than a glyph compares exactly"
            ),
            GlyphError::TooManyColors { colors } => {
                write!(f, "its glyph shows {colors} colours, more than {MAX_COLORS}")
            }
            GlyphError::UnknownStud { primitive } => {
                write!(f, "stud primitive {primitive} was not compiled for glyphs")
            }
        }
    }
}

pub struct StudMeshes {
    meshes: HashMap<String, Mesh>,
}

impl StudMeshes {
    pub fn compile<L: Library>(
        library: &L,
        primitives: &[String],
        unofficial_allowlist: &[String],
    ) -> Result<Self, CompileError> {
        let bare = CompileOptions {
            lod: Lod::Standard,
            stud_primitives: Vec::new(),
            unofficial_allowlist: unofficial_allowlist.to_vec(),
            technic: TechnicPrimitives::default(),
            rolling_mode: RollingMode::Skip,
        };
        let mut meshes = HashMap::new();
        for name in primitives {
            if !meshes.contains_key(name) {
                meshes.insert(name.clone(), compile_part(library, name, &bare)?.mesh);
            }
        }
        Ok(StudMeshes { meshes })
    }

    pub fn mesh(&self, primitive: &str) -> Option<&Mesh> {
        self.meshes.get(primitive)
    }
}

pub struct GlyphInstance<'a> {
    pub mesh: &'a Mesh,
    pub studs: &'a [StudReference],
    pub color: u32,
    pub matrix: &'a Affine,
}

pub struct GlyphBaker<'a> {
    studs: &'a StudMeshes,
    translucent: &'a HashSet<u32>,
}

fn resolve_color(color: u32, inherited: u32) -> u32 {
    if color == INHERIT_COLOR {
        inherited
    } else {
        color
    }
}

impl<'a> GlyphBaker<'a> {
    pub fn new(studs: &'a StudMeshes, translucent: &'a HashSet<u32>) -> Self {
        GlyphBaker { studs, translucent }
    }

    pub fn part(&self, mesh: &Mesh, studs: &[StudReference]) -> Result<Glyph, GlyphError> {
        self.model(&[GlyphInstance {
            mesh,
            studs,
            color: INHERIT_COLOR,
            matrix: &Affine::IDENTITY,
        }])
    }

    pub fn model(&self, instances: &[GlyphInstance]) -> Result<Glyph, GlyphError> {
        let mut triangles = PlanTriangles::new(self.translucent);
        for instance in instances {
            triangles.add(instance.mesh, instance.matrix, instance.color)?;
            for stud in instance.studs {
                let mesh =
                    self.studs
                        .mesh(&stud.primitive)
                        .ok_or_else(|| GlyphError::UnknownStud {
                            primitive: stud.primitive.clone(),
                        })?;
                triangles.add(
                    mesh,
                    &instance.matrix.then(&stud.matrix),
                    resolve_color(stud.color, instance.color),
                )?;
            }
        }
        rasterize(triangles)
    }
}
