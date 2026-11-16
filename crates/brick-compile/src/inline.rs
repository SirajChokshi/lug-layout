use std::collections::{HashMap, HashSet};

use crate::affine::Vec3;
use crate::flatten::{FlattenError, Flattened, Flattener, Library, Lod};
use crate::model::mpd_sections;

const LIBRARY_DIRECTORIES: [&str; 2] = ["parts/", "p/"];
const VERTEX_GRID_LDU: f64 = 1e-6;

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

fn vertices(flattened: &Flattened) -> Vec<Vec3> {
    let mut seen = HashSet::new();
    flattened
        .triangles
        .iter()
        .flat_map(|triangle| triangle.points)
        .filter(|p| seen.insert(p.map(|v| (v / VERTEX_GRID_LDU).round() as i64)))
        .collect()
}

fn directed_distance(from: &[Vec3], to: &[Vec3]) -> f64 {
    from.iter()
        .map(|p| {
            to.iter()
                .map(|q| (p[0] - q[0]).powi(2) + (p[1] - q[1]).powi(2) + (p[2] - q[2]).powi(2))
                .fold(f64::INFINITY, f64::min)
        })
        .fold(0.0, f64::max)
        .sqrt()
}

pub fn max_vertex_distance(a: &[Vec3], b: &[Vec3]) -> f64 {
    directed_distance(a, b).max(directed_distance(b, a))
}

pub fn inline_part_distance<L: Library>(
    library: &L,
    model_source: &str,
    inline: &str,
    official: &str,
) -> Result<f64, FlattenError> {
    let sections_first = SectionsFirst {
        sections: mpd_sections(model_source),
        library,
    };
    let inline_geometry = Flattener::new(&sections_first, Lod::Standard, &[]).flatten(inline)?;
    let official_geometry =
        Flattener::new(library, Lod::Standard, &[]).flatten(&format!("parts/{official}"))?;
    Ok(max_vertex_distance(
        &vertices(&inline_geometry),
        &vertices(&official_geometry),
    ))
}
