use std::collections::{BTreeMap, HashMap};

use crate::compile::{refuse_malformed, CompileError};
use crate::flatten::{Flattened, Flattener, Library, Lod};
use crate::mesh::WELD_EPSILON_LDU;
use crate::model::mpd_sections;
use crate::surface::{surface_match, Face, SurfaceMatch};

const LIBRARY_DIRECTORIES: [&str; 2] = ["parts/", "p/"];

struct SectionsFirst<'a, L: Library> {
    sections: HashMap<String, String>,
    library: &'a L,
}

impl<L: Library> Library for SectionsFirst<'_, L> {
    fn source(&self, path: &str) -> Option<&str> {
        let name = LIBRARY_DIRECTORIES
            .iter()
            .find_map(|directory| path.strip_prefix(directory))
            .unwrap_or(path);
        self.sections
            .get(name)
            .map(String::as_str)
            .or_else(|| self.library.source(path))
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct InlineComparison {
    pub surface_within_weld: bool,
    pub max_measured_distance: f64,
    pub inline_colors: Vec<u32>,
    pub official_colors: Vec<u32>,
}

impl InlineComparison {
    pub fn colors_match(&self) -> bool {
        self.inline_colors == self.official_colors
    }

    pub fn equivalent(&self) -> bool {
        self.colors_match() && self.surface_within_weld
    }
}

fn faces_by_color(flattened: &Flattened) -> BTreeMap<u32, Vec<Face>> {
    let mut faces: BTreeMap<u32, Vec<Face>> = BTreeMap::new();
    for triangle in &flattened.triangles {
        faces
            .entry(triangle.color)
            .or_default()
            .push(triangle.points);
    }
    faces
}

pub fn compare_inline_part<L: Library>(
    library: &L,
    model_source: &str,
    inline: &str,
    official: &str,
) -> Result<InlineComparison, CompileError> {
    let sections_first = SectionsFirst {
        sections: mpd_sections(model_source),
        library,
    };
    let mut inline_flattener = Flattener::new(&sections_first, Lod::Standard, &[]);
    let inline_flattened = inline_flattener.flatten(inline);
    let mut official_flattener = Flattener::new(library, Lod::Standard, &[]);
    let official_flattened = official_flattener.flatten(&format!("parts/{official}"));
    let inline_flattened = inline_flattened.map_err(CompileError::Flatten)?;
    let official_flattened = official_flattened.map_err(CompileError::Flatten)?;
    refuse_malformed(inline_flattener.malformed())?;
    refuse_malformed(official_flattener.malformed())?;
    let inline_faces = faces_by_color(&inline_flattened);
    let official_faces = faces_by_color(&official_flattened);
    let surface = inline_faces
        .iter()
        .filter_map(|(color, faces)| {
            Some(surface_match(
                faces,
                official_faces.get(color)?,
                WELD_EPSILON_LDU,
            ))
        })
        .fold(
            SurfaceMatch {
                within: true,
                max_measured: 0.0,
            },
            |all, one| SurfaceMatch {
                within: all.within && one.within,
                max_measured: all.max_measured.max(one.max_measured),
            },
        );
    Ok(InlineComparison {
        surface_within_weld: surface.within,
        max_measured_distance: surface.max_measured,
        inline_colors: inline_faces.keys().copied().collect(),
        official_colors: official_faces.keys().copied().collect(),
    })
}
