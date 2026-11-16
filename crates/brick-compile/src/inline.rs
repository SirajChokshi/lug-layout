use std::collections::{BTreeMap, HashMap, HashSet};

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

#[derive(Clone, Debug, PartialEq)]
pub struct InlineComparison {
    pub max_vertex_distance: f64,
    pub max_face_distance: f64,
    pub inline_colors: Vec<u32>,
    pub official_colors: Vec<u32>,
}

impl InlineComparison {
    pub fn colors_match(&self) -> bool {
        self.inline_colors == self.official_colors
    }

    pub fn max_distance(&self) -> f64 {
        self.max_vertex_distance.max(self.max_face_distance)
    }

    pub fn equivalent_within(&self, epsilon: f64) -> bool {
        self.colors_match() && self.max_distance() <= epsilon
    }
}

struct ColoredGeometry {
    vertices: BTreeMap<u32, Vec<Vec3>>,
    centroids: BTreeMap<u32, Vec<Vec3>>,
}

fn grid_key(point: Vec3) -> [i64; 3] {
    point.map(|v| (v / VERTEX_GRID_LDU).round() as i64)
}

fn colored_geometry(flattened: &Flattened) -> ColoredGeometry {
    let mut seen: HashSet<(u32, [i64; 3])> = HashSet::new();
    let mut vertices: BTreeMap<u32, Vec<Vec3>> = BTreeMap::new();
    let mut centroids: BTreeMap<u32, Vec<Vec3>> = BTreeMap::new();
    for triangle in &flattened.triangles {
        for point in triangle.points {
            if seen.insert((triangle.color, grid_key(point))) {
                vertices.entry(triangle.color).or_default().push(point);
            }
        }
        let centroid =
            [0, 1, 2].map(|axis| triangle.points.iter().map(|p| p[axis]).sum::<f64>() / 3.0);
        centroids.entry(triangle.color).or_default().push(centroid);
    }
    ColoredGeometry {
        vertices,
        centroids,
    }
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

fn per_color_distance(a: &BTreeMap<u32, Vec<Vec3>>, b: &BTreeMap<u32, Vec<Vec3>>) -> f64 {
    a.iter()
        .filter_map(|(color, points)| Some(max_vertex_distance(points, b.get(color)?)))
        .fold(0.0, f64::max)
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
    let inline_geometry =
        colored_geometry(&Flattener::new(&sections_first, Lod::Standard, &[]).flatten(inline)?);
    let official_geometry = colored_geometry(
        &Flattener::new(library, Lod::Standard, &[]).flatten(&format!("parts/{official}"))?,
    );
    Ok(InlineComparison {
        max_vertex_distance: per_color_distance(
            &inline_geometry.vertices,
            &official_geometry.vertices,
        ),
        max_face_distance: per_color_distance(
            &inline_geometry.centroids,
            &official_geometry.centroids,
        ),
        inline_colors: inline_geometry.vertices.keys().copied().collect(),
        official_colors: official_geometry.vertices.keys().copied().collect(),
    })
}
