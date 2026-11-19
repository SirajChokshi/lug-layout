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

    pub fn from_order(points: &[[Vec3; 3]], order: &[usize]) -> TriangleTree {
        let mut tree = TriangleTree {
            nodes: Vec::new(),
            triangles: Vec::with_capacity(order.len()),
        };
        if !order.is_empty() {
            tree.assemble(points, order, 0);
        }
        tree
    }

    fn assemble(&mut self, points: &[[Vec3; 3]], order: &[usize], first: usize) -> Bounds {
        let index = self.nodes.len();
        if order.len() <= LEAF_TRIANGLES {
            let bounds = order
                .iter()
                .flat_map(|&t| points[t])
                .fold(Bounds::EMPTY, Bounds::grow);
            self.nodes.push(TreeNode {
                bounds,
                link: Link::Leaf {
                    first,
                    count: order.len(),
                },
            });
            for &t in order {
                self.triangles.push(RayTriangle::new(&points[t]));
            }
            return bounds;
        }
        self.nodes.push(TreeNode {
            bounds: Bounds::EMPTY,
            link: Link::Branch { axis: 0, upper: 0 },
        });
        let (lower, upper) = order.split_at(order.len() / 2);
        let low = self.assemble(points, lower, first);
        let upper_index = self.nodes.len();
        let bounds = low.union(self.assemble(points, upper, first + lower.len()));
        let extent = sub(bounds.max, bounds.min);
        let axis = (0..3)
            .max_by(|&a, &b| extent[a].total_cmp(&extent[b]))
            .unwrap_or(0);
        self.nodes[index] = TreeNode {
            bounds,
            link: Link::Branch {
                axis,
                upper: upper_index,
            },
        };
        bounds
    }

    pub fn same_bits(&self, other: &TriangleTree) -> bool {
        let vec_bits = |v: &Vec3| v.map(f64::to_bits);
        let same_node = |a: &TreeNode, b: &TreeNode| {
            let same_link = match (a.link, b.link) {
                (Link::Leaf { first, count }, Link::Leaf { first: f, count: c }) => {
                    first == f && count == c
                }
                (Link::Branch { axis, upper }, Link::Branch { axis: x, upper: u }) => {
                    axis == x && upper == u
                }
                _ => false,
            };
            same_link
                && vec_bits(&a.bounds.min) == vec_bits(&b.bounds.min)
                && vec_bits(&a.bounds.max) == vec_bits(&b.bounds.max)
        };
        self.nodes.len() == other.nodes.len()
            && self
                .nodes
                .iter()
                .zip(&other.nodes)
                .all(|(a, b)| same_node(a, b))
            && self.triangles.len() == other.triangles.len()
            && self
                .triangles
                .iter()
                .zip(&other.triangles)
                .all(|(a, b)| a.same_bits(b))
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

    pub fn walk(&self, mut enter: impl FnMut(&Bounds, Option<Range<usize>>) -> bool) {
        let mut stack = Vec::new();
        if !self.nodes.is_empty() {
            stack.push(0);
        }
        while let Some(node) = stack.pop() {
            let TreeNode { bounds, link } = &self.nodes[node];
            match *link {
                Link::Leaf { first, count } => {
                    enter(bounds, Some(first..first + count));
                }
                Link::Branch { upper, .. } => {
                    if enter(bounds, None) {
                        stack.push(upper);
                        stack.push(node + 1);
                    }
                }
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    const SETS: u64 = 300;
    const MOST_TRIANGLES: u64 = 200;
    const GRID_STEPS: u64 = 8;
    const GRID_LDU: f64 = 0.5;
    const DUPLICATE_ONE_IN: u64 = 4;

    struct Scene(u64);

    impl Scene {
        fn next(&mut self, below: u64) -> u64 {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            self.0 % below.max(1)
        }

        fn point(&mut self) -> Vec3 {
            [0, 1, 2].map(|_| self.next(GRID_STEPS) as f64 * GRID_LDU)
        }
    }

    #[test]
    fn a_tree_rebuilt_from_its_order_is_the_tree_built_by_sorting() {
        let mut largest = 0;
        for set in 0..SETS {
            let mut scene = Scene(set * 2 + 1);
            let count = scene.next(MOST_TRIANGLES + 1) as usize;
            let mut points: Vec<[Vec3; 3]> = Vec::with_capacity(count);
            for _ in 0..count {
                let copy = scene.next(DUPLICATE_ONE_IN) == 0 && !points.is_empty();
                let triangle = if copy {
                    points[scene.next(points.len() as u64) as usize]
                } else {
                    [scene.point(), scene.point(), scene.point()]
                };
                points.push(triangle);
            }
            let (built, order) = TriangleTree::build(&points);
            assert!(
                TriangleTree::from_order(&points, &order).same_bits(&built),
                "set {set} of {count} triangles"
            );
            largest = largest.max(count);
        }
        assert!(largest > MOST_TRIANGLES as usize / 2);
    }
}
