use super::ray::{sub, AnchoredBounds, AnchoredTriangle, Bounds, Ray, RayTriangle};
use crate::affine::Vec3;

const LEAF_TRIANGLES: usize = 4;
const STACK_DEPTH: usize = 64;

#[derive(Clone, Copy)]
enum Link {
    Leaf { first: usize, count: usize },
    Branch { axis: usize, upper: usize },
}

struct TreeNode {
    bounds: Bounds,
    link: Link,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct TriangleHit {
    leaf: usize,
    triangle: usize,
}

pub(super) struct TriangleTree {
    nodes: Vec<TreeNode>,
    triangles: Vec<RayTriangle>,
}

impl TriangleTree {
    pub fn build(points: &[[Vec3; 3]]) -> (TriangleTree, Vec<usize>) {
        let mut tree = TriangleTree {
            nodes: Vec::new(),
            triangles: Vec::with_capacity(points.len()),
        };
        let mut order = Vec::with_capacity(points.len());
        if !points.is_empty() {
            tree.split((0..points.len()).collect(), points, &mut order);
        }
        (tree, order)
    }

    fn split(&mut self, mut triangles: Vec<usize>, points: &[[Vec3; 3]], order: &mut Vec<usize>) {
        let bounds = triangles
            .iter()
            .flat_map(|&t| points[t])
            .fold(Bounds::EMPTY, Bounds::grow);
        let index = self.nodes.len();
        if triangles.len() <= LEAF_TRIANGLES {
            self.nodes.push(TreeNode {
                bounds,
                link: Link::Leaf {
                    first: order.len(),
                    count: triangles.len(),
                },
            });
            for t in triangles {
                order.push(t);
                self.triangles.push(RayTriangle::new(&points[t]));
            }
            return;
        }
        let extent = sub(bounds.max, bounds.min);
        let axis = (0..3)
            .max_by(|&a, &b| extent[a].total_cmp(&extent[b]))
            .unwrap_or(0);
        let centre = |t: usize| points[t].iter().map(|p| p[axis]).sum::<f64>();
        triangles.sort_by(|&a, &b| centre(a).total_cmp(&centre(b)));
        let upper = triangles.split_off(triangles.len() / 2);
        self.nodes.push(TreeNode {
            bounds,
            link: Link::Branch { axis, upper: 0 },
        });
        self.split(triangles, points, order);
        let upper_index = self.nodes.len();
        self.split(upper, points, order);
        self.nodes[index].link = Link::Branch {
            axis,
            upper: upper_index,
        };
    }

    pub fn first_hit(&self, ray: &Ray, counts: impl Fn(usize) -> bool) -> Option<TriangleHit> {
        if self.nodes.is_empty() {
            return None;
        }
        let mut stack = [0_usize; STACK_DEPTH];
        let mut depth = 0;
        let mut node = 0;
        loop {
            let TreeNode { bounds, link } = &self.nodes[node];
            if bounds.entry(ray).is_some() {
                match *link {
                    Link::Leaf { first, count } => {
                        if let Some(triangle) = (first..first + count)
                            .find(|&t| counts(t) && self.triangles[t].blocks(ray))
                        {
                            return Some(TriangleHit {
                                leaf: node,
                                triangle,
                            });
                        }
                    }
                    Link::Branch { axis, upper } => {
                        let lower = node + 1;
                        let (near, far) = if ray.direction[axis] < 0.0 {
                            (upper, lower)
                        } else {
                            (lower, upper)
                        };
                        stack[depth] = far;
                        depth += 1;
                        node = near;
                        continue;
                    }
                }
            }
            if depth == 0 {
                return None;
            }
            depth -= 1;
            node = stack[depth];
        }
    }

    pub fn anchored(&self, origin: Vec3, hit: TriangleHit) -> AnchoredHit {
        AnchoredHit {
            leaf: self.nodes[hit.leaf].bounds.seen_from(origin),
            triangle: self.triangles[hit.triangle].seen_from(origin),
        }
    }
}

pub(super) struct AnchoredHit {
    leaf: AnchoredBounds,
    triangle: AnchoredTriangle,
}

impl AnchoredHit {
    pub fn confirms(&self, direction: Vec3, reach: f64) -> bool {
        self.leaf.entry(direction, reach).is_some() && self.triangle.blocks(direction, reach)
    }
}
