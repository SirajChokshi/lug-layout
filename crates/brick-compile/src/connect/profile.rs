use std::collections::HashMap;

pub type Point = [f64; 2];

#[derive(Clone, Debug, PartialEq)]
struct Piece {
    points: Vec<Point>,
    outline: Vec<bool>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Profile {
    pieces: Vec<Piece>,
    outline: Vec<Point>,
    pockets: Vec<Vec<Point>>,
    radius: f64,
    inner: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Placed {
    pieces: Vec<Piece>,
    outline: Vec<Point>,
    pockets: Vec<Vec<Point>>,
}

fn sub(a: Point, b: Point) -> Point {
    [a[0] - b[0], a[1] - b[1]]
}

fn turn(a: Point, b: Point, c: Point) -> f64 {
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}

fn area(points: &[Point]) -> f64 {
    let mut twice = 0.0;
    for (k, a) in points.iter().enumerate() {
        let b = points[(k + 1) % points.len()];
        twice += a[0] * b[1] - b[0] * a[1];
    }
    twice / 2.0
}

fn length(v: Point) -> f64 {
    v[0].hypot(v[1])
}

fn point_segment(p: Point, a: Point, b: Point) -> f64 {
    let d = sub(b, a);
    let span = d[0] * d[0] + d[1] * d[1];
    let t = if span == 0.0 {
        0.0
    } else {
        (((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1]) / span).clamp(0.0, 1.0)
    };
    length([p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1]])
}

fn segments_cross(a: Point, b: Point, c: Point, d: Point) -> bool {
    let apart = |k: usize| a[k].max(b[k]) < c[k].min(d[k]) || c[k].max(d[k]) < a[k].min(b[k]);
    if apart(0) || apart(1) {
        return false;
    }
    let (d1, d2) = (turn(c, d, a), turn(c, d, b));
    let (d3, d4) = (turn(a, b, c), turn(a, b, d));
    d1 * d2 <= 0.0 && d3 * d4 <= 0.0 && (d1 != d2 || d1 != 0.0) && (d3 != d4 || d3 != 0.0)
}

fn segment_distance(a: Point, b: Point, c: Point, d: Point) -> f64 {
    if segments_cross(a, b, c, d) {
        return 0.0;
    }
    point_segment(a, c, d)
        .min(point_segment(b, c, d))
        .min(point_segment(c, a, b))
        .min(point_segment(d, a, b))
}

fn edges(points: &[Point]) -> impl Iterator<Item = (Point, Point)> + '_ {
    (0..points.len()).map(move |k| (points[k], points[(k + 1) % points.len()]))
}

const PLAN_AXES: [Point; 2] = [[1.0, 0.0], [0.0, 1.0]];

fn axes<'a>(a: &'a [Point], b: &'a [Point]) -> impl Iterator<Item = Point> + 'a {
    edges(a)
        .chain(edges(b))
        .map(|(p, q)| sub(q, p))
        .filter(|d| d[0] != 0.0 || d[1] != 0.0)
        .map(|d| [-d[1], d[0]])
        .chain(PLAN_AXES)
}

fn extent(points: &[Point], axis: Point) -> (f64, f64) {
    points
        .iter()
        .map(|p| p[0] * axis[0] + p[1] * axis[1])
        .fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), v| {
            (lo.min(v), hi.max(v))
        })
}

fn overlap(a: &[Point], b: &[Point], closed: bool) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    axes(a, b).all(|axis| {
        let (a_low, a_high) = extent(a, axis);
        let (b_low, b_high) = extent(b, axis);
        if closed {
            a_high >= b_low && b_high >= a_low
        } else {
            a_high > b_low && b_high > a_low
        }
    })
}

fn clip(points: &[Point], a: Point, b: Point, shift: f64) -> Vec<Point> {
    let span = length(sub(b, a));
    let side = |p: Point| turn(a, b, p) / span - shift;
    let mut out = Vec::with_capacity(points.len() + 1);
    for (k, p) in points.iter().enumerate() {
        let q = points[(k + 1) % points.len()];
        let (sp, sq) = (side(*p), side(q));
        if sp >= 0.0 {
            out.push(*p);
        }
        if (sp >= 0.0) != (sq >= 0.0) {
            let t = sp / (sp - sq);
            out.push([p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])]);
        }
    }
    out
}

fn eroded(points: &[Point], shrink: impl Fn(usize) -> bool, by: f64) -> Vec<Point> {
    let mut out = points.to_vec();
    for k in 0..points.len() {
        if shrink(k) {
            out = clip(&out, points[k], points[(k + 1) % points.len()], by);
            if out.is_empty() {
                break;
            }
        }
    }
    out
}

fn hull(points: &[Point]) -> Vec<Point> {
    let mut sorted = points.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).expect("finite points"));
    sorted.dedup();
    if sorted.len() < 3 {
        return sorted;
    }
    let mut lower: Vec<Point> = Vec::new();
    for p in &sorted {
        while lower.len() >= 2 && turn(lower[lower.len() - 2], lower[lower.len() - 1], *p) <= 0.0 {
            lower.pop();
        }
        lower.push(*p);
    }
    let mut upper: Vec<Point> = Vec::new();
    for p in sorted.iter().rev() {
        while upper.len() >= 2 && turn(upper[upper.len() - 2], upper[upper.len() - 1], *p) <= 0.0 {
            upper.pop();
        }
        upper.push(*p);
    }
    lower.pop();
    upper.pop();
    lower.extend(upper);
    lower
}

fn convex(points: &[Point]) -> bool {
    points.len() >= 3
        && (0..points.len()).all(|k| {
            turn(
                points[k],
                points[(k + 1) % points.len()],
                points[(k + 2) % points.len()],
            ) >= 0.0
        })
}

fn without_collinear(points: Vec<Point>) -> Vec<Point> {
    let n = points.len();
    (0..n)
        .filter(|&k| turn(points[(k + n - 1) % n], points[k], points[(k + 1) % n]) != 0.0)
        .map(|k| points[k])
        .collect()
}

type Key = (i64, i64);

fn key(p: Point, step: f64) -> Key {
    ((p[0] / step).round() as i64, (p[1] / step).round() as i64)
}

fn merged(a: &[Point], b: &[Point], step: f64) -> Option<Vec<Point>> {
    for i in 0..a.len() {
        let (u, v) = (a[i], a[(i + 1) % a.len()]);
        for j in 0..b.len() {
            let (p, q) = (b[j], b[(j + 1) % b.len()]);
            if key(p, step) != key(v, step) || key(q, step) != key(u, step) {
                continue;
            }
            let mut out = Vec::new();
            for k in 0..a.len() {
                out.push(a[(i + 1 + k) % a.len()]);
            }
            out.pop();
            for k in 0..b.len() {
                out.push(b[(j + 1 + k) % b.len()]);
            }
            out.pop();
            let out = without_collinear(out);
            return convex(&out).then_some(out);
        }
    }
    None
}

fn rotated(p: Point, center: Point, angle: f64) -> Point {
    let (s, c) = angle.sin_cos();
    [
        center[0] + c * p[0] - s * p[1],
        center[1] + s * p[0] + c * p[1],
    ]
}

impl Profile {
    pub fn from_triangles(triangles: &[[Point; 3]], step: f64) -> Result<Profile, String> {
        let polygons: Vec<Vec<Point>> = triangles
            .iter()
            .filter(|t| area(t.as_slice()) != 0.0)
            .map(|t| {
                if area(t.as_slice()) > 0.0 {
                    t.to_vec()
                } else {
                    vec![t[0], t[2], t[1]]
                }
            })
            .collect();
        if polygons.is_empty() {
            return Err("profile part has no faces".to_string());
        }
        let mut directed: HashMap<(Key, Key), usize> = HashMap::new();
        let mut at: HashMap<Key, Point> = HashMap::new();
        for polygon in &polygons {
            for (p, q) in edges(polygon) {
                *directed.entry((key(p, step), key(q, step))).or_default() += 1;
                at.insert(key(p, step), p);
            }
        }
        let boundary: Vec<(Key, Key)> = directed
            .keys()
            .filter(|(p, q)| !directed.contains_key(&(*q, *p)))
            .copied()
            .collect();
        let next: HashMap<Key, Key> = boundary.iter().copied().collect();
        if next.len() != boundary.len() {
            return Err("profile outline branches".to_string());
        }
        let start = *boundary
            .iter()
            .map(|(p, _)| p)
            .min()
            .ok_or("profile has no outline")?;
        let mut loop_keys = vec![start];
        let mut current = next[&start];
        while current != start {
            loop_keys.push(current);
            current = *next.get(&current).ok_or("profile outline is open")?;
            if loop_keys.len() > boundary.len() {
                return Err("profile outline does not close".to_string());
            }
        }
        if loop_keys.len() != boundary.len() {
            return Err("profile outline has more than one loop".to_string());
        }
        let outline = without_collinear(loop_keys.iter().map(|k| at[k]).collect());
        let mut pieces = polygons;
        loop {
            let mut joined = None;
            'search: for i in 0..pieces.len() {
                for j in i + 1..pieces.len() {
                    if let Some(union) = merged(&pieces[i], &pieces[j], step) {
                        joined = Some((i, j, union));
                        break 'search;
                    }
                }
            }
            let Some((i, j, union)) = joined else {
                break;
            };
            pieces.remove(j);
            pieces[i] = union;
        }
        let on_outline = |p: Point, q: Point| {
            edges(&outline)
                .any(|(a, b)| point_segment(p, a, b) <= step && point_segment(q, a, b) <= step)
        };
        let pieces: Vec<Piece> = pieces
            .into_iter()
            .map(|points| Piece {
                outline: edges(&points).map(|(p, q)| on_outline(p, q)).collect(),
                points,
            })
            .collect();
        let shell = hull(&outline);
        let index = |p: Point| outline.iter().position(|o| key(*o, step) == key(p, step));
        let mut pockets = Vec::new();
        for (a, b) in edges(&shell) {
            let (Some(i), Some(j)) = (index(a), index(b)) else {
                return Err("profile hull leaves the outline".to_string());
            };
            if (i + 1) % outline.len() == j {
                continue;
            }
            let mut pocket = Vec::new();
            let mut k = i;
            loop {
                pocket.push(outline[k]);
                if k == j {
                    break;
                }
                k = (k + 1) % outline.len();
            }
            if area(&pocket) < 0.0 {
                pocket.reverse();
            }
            if !convex(&pocket) {
                return Err("profile pocket is not convex".to_string());
            }
            pockets.push(pocket);
        }
        let radius = outline.iter().map(|p| length(*p)).fold(0.0, f64::max);
        let inner = edges(&outline)
            .map(|(a, b)| point_segment([0.0, 0.0], a, b))
            .fold(f64::INFINITY, f64::min);
        Ok(Profile {
            pieces,
            outline,
            pockets,
            radius,
            inner,
        })
    }

    pub fn radius(&self) -> f64 {
        self.radius
    }

    pub fn sides(&self, quarter: f64, within: f64) -> Vec<[f64; 2]> {
        let mut out: Vec<[f64; 2]> = Vec::new();
        for (a, b) in edges(&self.outline) {
            let d = sub(b, a);
            let span = length(d);
            let distance = (a[0] * d[1] - a[1] * d[0]).abs() / span;
            let direction = d[1].atan2(d[0]).rem_euclid(quarter);
            if !out
                .iter()
                .any(|s| (s[0] - distance).abs() <= within && (s[1] - direction).abs() <= within)
            {
                out.push([distance, direction]);
            }
        }
        out
    }

    pub fn inner(&self) -> f64 {
        self.inner
    }

    pub fn has_pockets(&self) -> bool {
        !self.pockets.is_empty()
    }

    pub fn placed(&self, center: Point, angle: f64) -> Placed {
        let moved = |points: &[Point]| -> Vec<Point> {
            points.iter().map(|p| rotated(*p, center, angle)).collect()
        };
        Placed {
            pieces: self
                .pieces
                .iter()
                .map(|piece| Piece {
                    points: moved(&piece.points),
                    outline: piece.outline.clone(),
                })
                .collect(),
            outline: moved(&self.outline),
            pockets: self.pockets.iter().map(|p| moved(p)).collect(),
        }
    }

    pub fn symmetric_under(&self, angle: f64, within: f64) -> bool {
        let turned = self.placed([0.0, 0.0], angle);
        turned
            .outline
            .iter()
            .all(|p| edges(&self.outline).any(|(a, b)| point_segment(*p, a, b) <= within))
    }
}

impl Placed {
    pub fn eroded(&self, by: f64) -> Vec<Vec<Point>> {
        self.pieces
            .iter()
            .map(|piece| eroded(&piece.points, |k| piece.outline[k], by))
            .filter(|points| points.len() >= 3)
            .collect()
    }

    pub fn eroded_pockets(&self, by: f64) -> Vec<Vec<Point>> {
        self.pockets
            .iter()
            .map(|pocket| eroded(pocket, |_| true, by))
            .filter(|points| points.len() >= 3)
            .collect()
    }

    pub fn outline_covered(&self, section: &[Vec<Point>], within: f64) -> bool {
        edges(&self.outline).all(|(a, b)| {
            let middle = [vec![[(a[0] + b[0]) / 2.0, (a[1] + b[1]) / 2.0]]];
            section
                .iter()
                .any(|polygon| polygon_distance(&middle[0], polygon) <= within)
        })
    }

    pub fn swept_contact(&self, polygon: &[Point], step: Point) -> bool {
        self.pieces.iter().any(|piece| {
            let mut points = piece.points.clone();
            points.extend(
                piece
                    .points
                    .iter()
                    .map(|p| [p[0] + step[0], p[1] + step[1]]),
            );
            overlap(&hull(&points), polygon, true)
        })
    }

    pub fn contact(&self, polygon: &[Point]) -> bool {
        self.pieces
            .iter()
            .any(|piece| overlap(&piece.points, polygon, true))
    }
}

fn polygon_distance(a: &[Point], b: &[Point]) -> f64 {
    if b.is_empty() {
        return f64::INFINITY;
    }
    if overlap(a, b, true) {
        return 0.0;
    }
    let sides = |points: &[Point]| -> Vec<(Point, Point)> {
        if points.len() == 1 {
            vec![(points[0], points[0])]
        } else {
            edges(points).collect()
        }
    };
    let (sa, sb) = (sides(a), sides(b));
    sa.iter()
        .flat_map(|(p, q)| {
            sb.iter()
                .map(move |(r, t)| segment_distance(*p, *q, *r, *t))
        })
        .fold(f64::INFINITY, f64::min)
}

pub fn collides(pieces: &[Vec<Point>], polygon: &[Point]) -> bool {
    pieces.iter().any(|piece| overlap(piece, polygon, false))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit_square() -> Placed {
        let triangles = [
            [[-1.0, -1.0], [1.0, -1.0], [1.0, 1.0]],
            [[-1.0, -1.0], [1.0, 1.0], [-1.0, 1.0]],
        ];
        Profile::from_triangles(&triangles, 1e-6)
            .expect("a square is a profile")
            .placed([0.0, 0.0], 0.0)
    }

    #[test]
    fn an_outline_side_is_covered_only_by_a_wall_that_reaches_it() {
        let square = unit_square();
        let three_sides = vec![
            vec![[-1.0, -1.0], [1.0, -1.0], [0.0, -1.0]],
            vec![[-1.0, 1.0], [-1.0, -1.0], [-1.0, 0.0]],
            vec![[1.0, 1.0], [-1.0, 1.0], [0.0, 1.0]],
        ];
        let with = |wall: Vec<Point>| {
            let mut section = three_sides.clone();
            section.push(wall);
            square.outline_covered(&section, 1e-4)
        };
        assert!(with(vec![[1.0, -1.0], [1.0, 1.0], [1.0, 0.0]]));
        assert!(!with(vec![[1.0, 5.0], [1.0, 7.0], [1.0, 6.0]]));
        assert!(!with(vec![[5.0, 5.0], [7.0, 7.0], [6.0, 6.0]]));
    }
}
