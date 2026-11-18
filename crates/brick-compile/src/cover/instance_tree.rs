use super::ray::{Bounds, Ray};
use crate::affine::Vec3;

const LEAF_INSTANCES: usize = 2;
const STACK_DEPTH: usize = 64;

#[derive(Clone, Copy)]
enum Link {
    Leaf { first: usize, count: usize },
    Branch { upper: usize },
}

struct TreeNode {
    bounds: Bounds,
    link: Link,
}

pub(super) struct InstanceTree {
    nodes: Vec<TreeNode>,
    members: Vec<(usize, Bounds)>,
}

impl InstanceTree {
    pub fn build(boxes: Vec<(usize, Bounds)>) -> Self {
        let mut tree = InstanceTree {
            nodes: Vec::new(),
            members: Vec::with_capacity(boxes.len()),
        };
        if !boxes.is_empty() {
            tree.split(boxes);
        }
        tree
    }

    fn split(&mut self, mut boxes: Vec<(usize, Bounds)>) {
        let bounds = boxes
            .iter()
            .fold(Bounds::EMPTY, |all, (_, bounds)| all.union(*bounds));
        let index = self.nodes.len();
        if boxes.len() <= LEAF_INSTANCES {
            self.nodes.push(TreeNode {
                bounds,
                link: Link::Leaf {
                    first: self.members.len(),
                    count: boxes.len(),
                },
            });
            self.members.extend(boxes);
            return;
        }
        let centres = boxes.iter().fold(Bounds::EMPTY, |all, (_, bounds)| {
            all.grow([0, 1, 2].map(|axis| bounds.centre(axis)))
        });
        let axis = (0..3)
            .max_by(|&a, &b| {
                let extent = |axis: usize| centres.max[axis] - centres.min[axis];
                extent(a).total_cmp(&extent(b))
            })
            .unwrap_or(0);
        boxes.sort_by(|(_, a), (_, b)| a.centre(axis).total_cmp(&b.centre(axis)));
        let upper = boxes.split_off(boxes.len() / 2);
        self.nodes.push(TreeNode {
            bounds,
            link: Link::Branch { upper: 0 },
        });
        self.split(boxes);
        let upper_index = self.nodes.len();
        self.split(upper);
        self.nodes[index].link = Link::Branch { upper: upper_index };
    }

    pub fn any_along(&self, ray: &Ray, mut visit: impl FnMut(usize) -> bool) -> bool {
        if self
            .nodes
            .first()
            .is_none_or(|root| root.bounds.entry(ray).is_none())
        {
            return false;
        }
        let mut stack = [0_usize; STACK_DEPTH];
        let mut depth = 0;
        let mut node = 0;
        loop {
            match self.nodes[node].link {
                Link::Leaf { first, count } => {
                    let found = self.members[first..first + count]
                        .iter()
                        .any(|(instance, bounds)| bounds.entry(ray).is_some() && visit(*instance));
                    if found {
                        return true;
                    }
                }
                Link::Branch { upper } => {
                    let lower = node + 1;
                    let entries = [lower, upper].map(|child| self.nodes[child].bounds.entry(ray));
                    match entries {
                        [Some(a), Some(b)] => {
                            let (near, far) = if a <= b {
                                (lower, upper)
                            } else {
                                (upper, lower)
                            };
                            stack[depth] = far;
                            depth += 1;
                            node = near;
                            continue;
                        }
                        [Some(_), None] => {
                            node = lower;
                            continue;
                        }
                        [None, Some(_)] => {
                            node = upper;
                            continue;
                        }
                        [None, None] => {}
                    }
                }
            }
            if depth == 0 {
                return false;
            }
            depth -= 1;
            node = stack[depth];
        }
    }

    pub fn containing(&self, point: Vec3, found: &mut Vec<usize>) {
        found.clear();
        if self.nodes.is_empty() {
            return;
        }
        let mut stack = [0_usize; STACK_DEPTH];
        let mut depth = 1;
        while depth > 0 {
            depth -= 1;
            let node = stack[depth];
            let TreeNode { bounds, link } = &self.nodes[node];
            if !bounds.contains(point) {
                continue;
            }
            match *link {
                Link::Leaf { first, count } => found.extend(
                    self.members[first..first + count]
                        .iter()
                        .filter(|(_, bounds)| bounds.contains(point))
                        .map(|(instance, _)| *instance),
                ),
                Link::Branch { upper } => {
                    stack[depth] = node + 1;
                    stack[depth + 1] = upper;
                    depth += 2;
                }
            }
        }
        found.sort_unstable();
    }
}
