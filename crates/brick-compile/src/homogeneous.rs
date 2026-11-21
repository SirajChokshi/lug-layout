use std::cmp::Ordering;

use crate::circle::{cross, dot, is_origin, Direction};
use crate::exact::{Exact, ExactVec3};

#[derive(Clone, Debug)]
pub struct Homogeneous {
    pub point: ExactVec3,
    pub weight: Exact,
}

impl Homogeneous {
    pub fn of(point: ExactVec3) -> Homogeneous {
        Homogeneous {
            point,
            weight: Exact::integer(1),
        }
    }

    pub fn relative(&self, axes: (usize, usize), center: &Direction) -> Direction {
        [
            self.point[axes.0].sub(&center[0].mul(&self.weight)),
            self.point[axes.1].sub(&center[1].mul(&self.weight)),
        ]
    }
}

fn clip_against(
    polygon: Vec<Homogeneous>,
    inside: impl Fn(&Homogeneous) -> Exact,
) -> Vec<Homogeneous> {
    let mut out = Vec::with_capacity(polygon.len() + 1);
    for (k, current) in polygon.iter().enumerate() {
        let next = &polygon[(k + 1) % polygon.len()];
        let (here, there) = (inside(current), inside(next));
        let here_in = here.sign() != Ordering::Less;
        let there_in = there.sign() != Ordering::Less;
        if here_in {
            out.push(current.clone());
        }
        if here_in != there_in {
            let point: ExactVec3 = std::array::from_fn(|c| {
                current.point[c].mul(&there).sub(&next.point[c].mul(&here))
            });
            let weight = current.weight.mul(&there).sub(&next.weight.mul(&here));
            let crossing = if weight.sign() == Ordering::Less {
                Homogeneous {
                    point: point.map(|v| v.neg()),
                    weight: weight.neg(),
                }
            } else {
                Homogeneous { point, weight }
            };
            out.push(crossing);
        }
    }
    out
}

pub fn clip_between(
    polygon: Vec<Homogeneous>,
    axis: usize,
    low: &Exact,
    high: &Exact,
) -> Vec<Homogeneous> {
    let above = clip_against(polygon, |p| p.point[axis].sub(&low.mul(&p.weight)));
    if above.is_empty() {
        return above;
    }
    clip_against(above, |p| high.mul(&p.weight).sub(&p.point[axis]))
}

pub fn touches_origin(directions: &[Direction]) -> bool {
    if directions.iter().any(is_origin) {
        return true;
    }
    let turns: Vec<Ordering> = (0..directions.len())
        .map(|k| cross(&directions[k], &directions[(k + 1) % directions.len()]).sign())
        .collect();
    let left = turns.contains(&Ordering::Greater);
    let right = turns.contains(&Ordering::Less);
    if left && right {
        return false;
    }
    if left || right {
        return true;
    }
    directions.iter().enumerate().any(|(k, a)| {
        directions[k + 1..]
            .iter()
            .any(|b| dot(a, b).sign() == Ordering::Less)
    })
}

pub fn ray_crosses(directions: &[Direction], along: usize, forward: Ordering) -> bool {
    let across = 1 - along;
    (0..directions.len()).any(|k| {
        let a = &directions[k];
        let b = &directions[(k + 1) % directions.len()];
        let (sa, sb) = (a[across].sign(), b[across].sign());
        if sa != Ordering::Equal && sa == sb {
            return false;
        }
        if sa == Ordering::Equal && sb == Ordering::Equal {
            let ahead = |d: &Direction| d[along].sign() == forward || d[along].is_zero();
            return ahead(a) || ahead(b);
        }
        let crossing = a[across]
            .mul(&b[along])
            .sub(&a[along].mul(&b[across]))
            .sign();
        let span = a[across].sub(&b[across]).sign();
        let value = match (crossing, span) {
            (Ordering::Equal, _) => Ordering::Equal,
            (c, s) if c == s => Ordering::Greater,
            _ => Ordering::Less,
        };
        value == Ordering::Equal || value == forward
    })
}
