use super::{Blocker, Fan, FanRays, ModelSolids, Segment, StudFrame, StudShape};
use super::{BELOW_ELEVATION_STEPS, BELOW_REACH_LDU};
use crate::affine::Vec3;

const RECENT_BLOCKERS: usize = 8;
const FAN_RAYS: u64 = u64::MAX >> (u64::BITS as usize - BELOW_ELEVATION_STEPS);

pub(super) fn rays_in(mut rays: u64) -> impl Iterator<Item = usize> {
    std::iter::from_fn(move || {
        (rays != 0).then(|| {
            let ray = rays.trailing_zeros() as usize;
            rays &= rays - 1;
            ray
        })
    })
}

pub(super) struct BelowSearch<'m, 'a> {
    model: &'m ModelSolids<'a>,
    recent: Vec<Blocker>,
    held: [Option<Blocker>; BELOW_ELEVATION_STEPS],
    groups: Vec<(Blocker, u64)>,
    found: Vec<Blocker>,
}

impl<'m, 'a> BelowSearch<'m, 'a> {
    pub fn new(model: &'m ModelSolids<'a>) -> Self {
        BelowSearch {
            model,
            recent: Vec::with_capacity(RECENT_BLOCKERS + 1),
            held: [None; BELOW_ELEVATION_STEPS],
            groups: Vec::new(),
            found: Vec::new(),
        }
    }

    pub fn closed(mut self, stud: StudFrame, shape: StudShape) -> bool {
        stud.all_fans_below(shape, |origin, fan| self.fan_closed(origin, fan))
    }

    fn fan_closed(&mut self, origin: Vec3, fan: &Fan) -> bool {
        let rays = FanRays::new(origin, fan, BELOW_REACH_LDU);
        let mut pending = FAN_RAYS;
        self.group_held();
        for &(blocker, group) in &self.groups {
            pending &= !self.model.confirmed_rays(blocker, &rays, group);
        }
        let mut useful = [false; RECENT_BLOCKERS];
        for (slot, blocker) in self.recent.iter().enumerate() {
            if pending == 0 {
                break;
            }
            let confirmed = self.model.confirmed_rays(*blocker, &rays, pending);
            hold(&mut self.held, confirmed, *blocker);
            useful[slot] = confirmed != 0;
            pending &= !confirmed;
        }
        self.favour(useful);
        self.found.clear();
        for ray in rays_in(pending) {
            let segment = Segment::new(origin, fan[ray], BELOW_REACH_LDU);
            let known = self
                .found
                .iter()
                .copied()
                .find(|blocker| self.model.confirms(*blocker, &segment));
            let Some(blocker) = known.or_else(|| self.model.search(&segment)) else {
                return false;
            };
            if known.is_none() {
                self.found.push(blocker);
                self.remember(blocker);
            }
            hold(&mut self.held, 1 << ray, blocker);
        }
        true
    }

    fn group_held(&mut self) {
        self.groups.clear();
        for (ray, held) in self.held.iter().enumerate() {
            let Some(blocker) = *held else {
                continue;
            };
            match self
                .groups
                .iter_mut()
                .rev()
                .find(|(known, _)| *known == blocker)
            {
                Some((_, rays)) => *rays |= 1 << ray,
                None => self.groups.push((blocker, 1 << ray)),
            }
        }
    }

    fn remember(&mut self, blocker: Blocker) {
        self.recent.insert(0, blocker);
        self.recent.truncate(RECENT_BLOCKERS);
    }

    fn favour(&mut self, useful: [bool; RECENT_BLOCKERS]) {
        let mut front = 0;
        for (slot, useful) in useful.into_iter().enumerate().take(self.recent.len()) {
            if useful {
                self.recent[front..=slot].rotate_right(1);
                front += 1;
            }
        }
    }
}

fn hold(held: &mut [Option<Blocker>; BELOW_ELEVATION_STEPS], rays: u64, blocker: Blocker) {
    for ray in rays_in(rays) {
        held[ray] = Some(blocker);
    }
}
