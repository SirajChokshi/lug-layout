use std::ops::Range;

use super::ray::{sub, Bounds, Ray, RayTriangle};
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

    pub fn confirms(&self, ray: &Ray, hit: TriangleHit, counts: impl Fn(usize) -> bool) -> bool {
        counts(hit.triangle)
            && self.nodes[hit.leaf].bounds.entry(ray).is_some()
            && self.triangles[hit.triangle].blocks(ray)
    }

    pub fn find_hit<T>(
        &self,
        ray: &Ray,
        counts: impl Fn(usize) -> bool,
        mut accept: impl FnMut(usize) -> Option<T>,
        blocked: &mut bool,
    ) -> Option<T> {
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
                        for (triangle, shape) in
                            self.triangles.iter().enumerate().skip(first).take(count)
                        {
                            if !counts(triangle) || !shape.blocks(ray) {
                                continue;
                            }
                            *blocked = true;
                            if let Some(found) = accept(triangle) {
                                return Some(found);
                            }
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

    pub fn each_leaf(&self, mut visit: impl FnMut(Range<usize>, &[Bounds])) {
        let mut ancestors = Vec::new();
        if !self.nodes.is_empty() {
            self.visit_leaves(0, &mut ancestors, &mut visit);
        }
    }

    fn visit_leaves(
        &self,
        node: usize,
        ancestors: &mut Vec<Bounds>,
        visit: &mut impl FnMut(Range<usize>, &[Bounds]),
    ) {
        let TreeNode { bounds, link } = &self.nodes[node];
        ancestors.push(*bounds);
        match *link {
            Link::Leaf { first, count } => visit(first..first + count, ancestors),
            Link::Branch { upper, .. } => {
                self.visit_leaves(node + 1, ancestors, visit);
                self.visit_leaves(upper, ancestors, visit);
            }
        }
        ancestors.pop();
    }
}
