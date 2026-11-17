use std::collections::{BTreeMap, HashMap};

use crate::flatten::{FlattenError, Flattened, Flattener, Library, Lod};
use crate::mesh::WELD_EPSILON_LDU;
use crate::model::mpd_sections;
use crate::surface::{surface_distance, Face};

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
    pub max_surface_distance: f64,
    pub inline_colors: Vec<u32>,
    pub official_colors: Vec<u32>,
}

impl InlineComparison {
    pub fn colors_match(&self) -> bool {
        self.inline_colors == self.official_colors
    }

    pub fn equivalent_within(&self, epsilon: f64) -> bool {
        self.colors_match() && self.max_surface_distance <= epsilon
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
) -> Result<InlineComparison, FlattenError> {
    let sections_first = SectionsFirst {
        sections: mpd_sections(model_source),
        library,
    };
    let inline_faces =
        faces_by_color(&Flattener::new(&sections_first, Lod::Standard, &[]).flatten(inline)?);
    let official_faces = faces_by_color(
        &Flattener::new(library, Lod::Standard, &[]).flatten(&format!("parts/{official}"))?,
    );
    let max_surface_distance = inline_faces
        .iter()
        .filter_map(|(color, faces)| {
            Some(surface_distance(
                faces,
                official_faces.get(color)?,
                WELD_EPSILON_LDU,
            ))
        })
        .fold(0.0, f64::max);
    Ok(InlineComparison {
        max_surface_distance,
        inline_colors: inline_faces.keys().copied().collect(),
        official_colors: official_faces.keys().copied().collect(),
    })
}
