use super::{
    FaceSection, MatingFace, AXLE, BOX, CAP_FAR, CAP_ROOT, FEMALE_FINGER, FINGER_RADIUS_UNSTATED,
    FLARE_JOINS_NEXT, FLARE_JOINS_PREVIOUS, MALE_FINGER, ROUND, SQUARE,
};
use crate::identify::SIXTEENTHS_PER_LDU;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fit {
    Misfit,
    Loose,
    Touching,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Reading {
    code: u8,
    size: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct SnapSection {
    span: f64,
    size: f64,
    male: Reading,
    female: Reading,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SnapShape {
    caps: u8,
    slide: bool,
    group: Option<String>,
    sections: Vec<SnapSection>,
    length: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ShapeError {
    NoSections,
    Span { section: usize, span: f64 },
}

impl std::fmt::Display for ShapeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ShapeError::NoSections => write!(f, "a snap shape needs at least one section"),
            ShapeError::Span { section, span } => {
                write!(f, "snap section {section} has length {span}")
            }
        }
    }
}

enum FlarePartner {
    NotAFlare,
    Missing,
    At(usize),
}

fn flare_partner(code: u8, index: usize, count: usize) -> FlarePartner {
    let neighbour = match code {
        FLARE_JOINS_PREVIOUS => index.checked_sub(1),
        FLARE_JOINS_NEXT => Some(index + 1),
        _ => return FlarePartner::NotAFlare,
    };
    match neighbour {
        Some(at) if at < count => FlarePartner::At(at),
        _ => FlarePartner::Missing,
    }
}

impl SnapShape {
    pub fn new(
        caps: u8,
        slide: bool,
        group: Option<&str>,
        sections: &[FaceSection],
    ) -> Result<SnapShape, ShapeError> {
        if sections.is_empty() {
            return Err(ShapeError::NoSections);
        }
        if let Some((section, span)) = sections
            .iter()
            .map(|section| section.length)
            .enumerate()
            .find(|(_, span)| !(span.is_finite() && *span >= 0.0))
        {
            return Err(ShapeError::Span { section, span });
        }
        let read = |index: usize, section: &FaceSection| {
            let own = Reading {
                code: section.code,
                size: section.size,
            };
            let partner = flare_partner(section.code, index, sections.len());
            let flare = !matches!(partner, FlarePartner::NotAFlare);
            let male = match partner {
                FlarePartner::At(at) if sections[at].code == ROUND => Reading {
                    code: ROUND,
                    size: sections[at].size,
                },
                _ => own,
            };
            let female = if flare {
                Reading { code: ROUND, ..own }
            } else {
                own
            };
            SnapSection {
                span: section.length,
                size: section.size,
                male,
                female,
            }
        };
        Ok(SnapShape {
            caps,
            slide,
            group: group.filter(|token| !token.is_empty()).map(str::to_string),
            sections: sections
                .iter()
                .enumerate()
                .map(|(index, section)| read(index, section))
                .collect(),
            length: sections
                .iter()
                .fold(0.0, |length, section| length + section.length),
        })
    }

    pub fn of_face(face: &MatingFace) -> Result<SnapShape, ShapeError> {
        SnapShape::new(face.caps, face.slide, face.group.as_deref(), &face.sections)
    }

    fn capped(&self, cap: u8) -> bool {
        self.caps & cap != 0
    }

    fn span(&self, section: usize) -> f64 {
        self.sections.get(section).map_or(0.0, |found| found.span)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct EngagedOffsets {
    ranges: Vec<[i32; 2]>,
}

impl EngagedOffsets {
    pub fn ranges(&self) -> &[[i32; 2]] {
        &self.ranges
    }

    pub fn contains(&self, offset_sixteenths: i32) -> bool {
        self.ranges
            .iter()
            .take_while(|range| offset_sixteenths >= range[0])
            .any(|range| offset_sixteenths <= range[1])
    }

    fn add(&mut self, from: i64, to: i64) {
        let [from, to] = [from, to].map(|bound| bound as i32);
        match self.ranges.last_mut() {
            Some(last) if last[1] + 1 >= from => last[1] = last[1].max(to),
            _ => self.ranges.push([from, to]),
        }
    }
}

fn has_reading(code: u8) -> bool {
    code == ROUND || code == AXLE || code == SQUARE
}

fn inside(inner: f64, outer: f64) -> Fit {
    if inner < outer {
        Fit::Loose
    } else if inner == outer {
        Fit::Touching
    } else {
        Fit::Misfit
    }
}

fn containment(male: Reading, female: Reading) -> Fit {
    let symmetric = has_reading(male.code);
    match female.code {
        AXLE if male.code == AXLE => inside(male.size, female.size),
        AXLE => Fit::Misfit,
        SQUARE if symmetric => inside(male.size, female.size),
        ROUND if symmetric && male.code == SQUARE => {
            inside(2.0 * male.size * male.size, female.size * female.size)
        }
        ROUND if symmetric => inside(male.size, female.size),
        _ => Fit::Misfit,
    }
}

fn interleaves(male: u8, female: u8) -> bool {
    (male == MALE_FINGER && female == FEMALE_FINGER)
        || (male == FEMALE_FINGER && female == MALE_FINGER)
}

fn radii_agree(male: f64, female: f64) -> bool {
    male == FINGER_RADIUS_UNSTATED || female == FINGER_RADIUS_UNSTATED || male == female
}

pub struct Mate<'s> {
    male: &'s SnapShape,
    female: &'s SnapShape,
}

impl<'s> Mate<'s> {
    pub fn new(male: &'s SnapShape, female: &'s SnapShape) -> Mate<'s> {
        Mate { male, female }
    }

    pub fn offsets(&self) -> EngagedOffsets {
        let mut engaged = EngagedOffsets::default();
        if self.male.group != self.female.group {
            return engaged;
        }
        let travel = (self.male.length - self.female.length) * f64::from(SIXTEENTHS_PER_LDU);
        let threadable = !self.female.capped(CAP_FAR) || !self.male.capped(CAP_ROOT);
        let sliding = self.male.slide || self.female.slide;
        let shorter = self.female.length <= self.male.length;
        let (low, high) = if sliding || threadable {
            (
                if shorter { 0 } else { travel.ceil() as i64 },
                if shorter { travel.floor() as i64 } else { 0 },
            )
        } else {
            (0, 0)
        };
        let partway = sliding && threadable;
        let events = self.events(low, high);
        for (i, &at) in events.iter().enumerate() {
            if self.engaged_at(at, low, high, partway) {
                engaged.add(at, at);
            }
            let Some(&next) = events.get(i + 1) else {
                continue;
            };
            if next - at >= 2 && self.engaged_at(at + 1, low, high, partway) {
                engaged.add(at + 1, next - 1);
            }
        }
        engaged
    }

    fn events(&self, low: i64, high: i64) -> Vec<i64> {
        let per_ldu = f64::from(SIXTEENTHS_PER_LDU);
        let mut events = vec![low, high];
        let mut male_at = 0.0;
        for m in 0..=self.male.sections.len() {
            if m > 0 {
                male_at += self.male.span(m - 1);
            }
            let mut female_at = 0.0;
            for f in 0..=self.female.sections.len() {
                if f > 0 {
                    female_at += self.female.span(f - 1);
                }
                let d = (male_at - female_at) * per_ldu;
                events.extend([d.floor() as i64, d.ceil() as i64]);
            }
        }
        events.sort_unstable();
        events.dedup();
        events
    }

    fn engaged_at(&self, sixteenths: i64, low: i64, high: i64, partway: bool) -> bool {
        let offset = sixteenths as f64 / f64::from(SIXTEENTHS_PER_LDU);
        if !self.stops_allow(offset) || !self.contains(offset) {
            return false;
        }
        partway || (low..=high).contains(&sixteenths) || self.seated(offset)
    }

    fn seated(&self, offset: f64) -> bool {
        let female_far = offset + self.female.length;
        let male_length = self.male.length;
        (self.female.capped(CAP_FAR) && female_far <= male_length)
            || (self.male.capped(CAP_FAR) && female_far >= male_length)
            || self.meets_blocking_section(offset)
    }

    fn meets_blocking_section(&self, offset: f64) -> bool {
        let mut male_from = 0.0;
        for male in &self.male.sections {
            let male_to = male_from + male.span;
            let mut female_from = offset;
            for female in &self.female.sections {
                let female_to = female_from + female.span;
                let meeting = male_to == female_from || female_to == male_from;
                if meeting && self.blocks(male, female, offset, [male_from, male_to]) {
                    return true;
                }
                female_from = female_to;
            }
            male_from = male_to;
        }
        false
    }

    fn blocks(
        &self,
        male: &SnapSection,
        female: &SnapSection,
        offset: f64,
        male_span: [f64; 2],
    ) -> bool {
        if !has_reading(male.male.code) || !has_reading(female.female.code) {
            return false;
        }
        if containment(male.male, female.female) == Fit::Misfit {
            return true;
        }
        let relaxed = Reading {
            code: male.male.code,
            size: male.size,
        };
        containment(relaxed, female.female) == Fit::Misfit
            && self.relaxed_within(relaxed, offset, male_span)
    }

    fn relaxed_within(
        &self,
        relaxed: Reading,
        offset: f64,
        [male_from, male_to]: [f64; 2],
    ) -> bool {
        let mut female_from = offset;
        for female in &self.female.sections {
            let female_to = female_from + female.span;
            let overlapping = male_to.min(female_to) - male_from.max(female_from) > 0.0;
            if overlapping && containment(relaxed, female.female) == Fit::Misfit {
                return false;
            }
            female_from = female_to;
        }
        true
    }

    fn stops_allow(&self, offset: f64) -> bool {
        let female_far = offset + self.female.length;
        let male_length = self.male.length;
        if self.male.capped(CAP_ROOT) && offset < 0.0 {
            return false;
        }
        if self.female.capped(CAP_FAR) && female_far < male_length {
            return false;
        }
        !self.male.capped(CAP_FAR) || female_far <= male_length
    }

    fn contains(&self, offset: f64) -> bool {
        let compares_radii = self.male.group.is_none();
        let mut touched = false;
        let fits = self.overlaps(offset, |male, female, shared| {
            let fit = Self::fit(male, female, shared, compares_radii);
            touched |= fit == Fit::Touching;
            fit != Fit::Misfit
        });
        fits && touched
    }

    fn fit(male: &SnapSection, female: &SnapSection, shared: f64, compares_radii: bool) -> Fit {
        if male.male.code == BOX || female.female.code == BOX {
            return if male.male.code == female.female.code {
                Fit::Touching
            } else {
                Fit::Misfit
            };
        }
        if interleaves(male.male.code, female.female.code) {
            let exact = shared == male.span && shared == female.span;
            let radii = !compares_radii || radii_agree(male.male.size, female.female.size);
            return if exact && radii {
                Fit::Touching
            } else {
                Fit::Misfit
            };
        }
        containment(male.male, female.female)
    }

    fn overlaps(
        &self,
        offset: f64,
        mut visit: impl FnMut(&SnapSection, &SnapSection, f64) -> bool,
    ) -> bool {
        let (males, females) = (&self.male.sections, &self.female.sections);
        let (mut m, mut f) = (0, 0);
        let mut male_from: f64 = 0.0;
        let mut male_to = self.male.span(m);
        let mut female_from = offset;
        let mut female_to = offset + self.female.span(f);
        while m < males.len() && f < females.len() {
            let shared = male_to.min(female_to) - male_from.max(female_from);
            let degenerate = male_to == male_from || female_to == female_from;
            if (shared > 0.0 || (shared == 0.0 && degenerate))
                && !visit(&males[m], &females[f], shared)
            {
                return false;
            }
            if male_to <= female_to {
                m += 1;
                male_from = male_to;
                male_to += self.male.span(m);
            } else {
                f += 1;
                female_from = female_to;
                female_to += self.female.span(f);
            }
        }
        true
    }
}
