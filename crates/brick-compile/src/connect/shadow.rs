use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::affine::{Affine, Vec3};
use crate::flatten::{resolve_reference, Library, Lod};
use crate::lattice::{non_finite, record, unplaceable, Malformation, MalformedGeometry};
use crate::ldraw::{self, Line};

use super::meta::{parse_metas, Meta, ParsedMeta};
use super::{
    finished, malformed_shape, placeable_cells, placed, slots, Connector, Extraction, Issue, Slot,
    Source, Status,
};

const MAX_DEPTH: usize = 64;
const PART_FOLDER: &str = "parts/";
const IDENTITY_ROTATION: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

#[derive(Default)]
struct Gathered {
    connectors: Vec<Connector>,
    suppressed: Vec<Connector>,
    issues: Vec<Issue>,
    children: Vec<String>,
    curated: bool,
}

pub struct ShadowPatches<'a, S: Library + ?Sized> {
    pub files: &'a S,
    pub verified: &'a HashSet<String>,
}

#[derive(Clone, Copy)]
struct Tier {
    source: Source,
    status: Status,
}

pub struct ShadowSnaps<'a, L: Library + ?Sized, S: Library + ?Sized> {
    library: &'a L,
    shadow: &'a S,
    patches: Option<ShadowPatches<'a, S>>,
    gathered: HashMap<String, Rc<Gathered>>,
}

fn shifted(offset: Vec3) -> Affine {
    Affine::from_ldraw(offset, IDENTITY_ROTATION)
}

impl<'a, L: Library + ?Sized, S: Library + ?Sized> ShadowSnaps<'a, L, S> {
    pub fn new(library: &'a L, shadow: &'a S) -> Self {
        ShadowSnaps {
            library,
            shadow,
            patches: None,
            gathered: HashMap::new(),
        }
    }

    pub fn patched(mut self, patches: ShadowPatches<'a, S>) -> Self {
        self.patches = Some(patches);
        self
    }

    pub fn snaps(&mut self, path: &str) -> Extraction {
        let gathered = self.gather(path, 0);
        let mut issues = Vec::new();
        let mut seen = HashSet::new();
        self.closure_issues(path, &mut seen, &mut issues);
        let mut malformed = Vec::new();
        let mut placeable: Vec<Connector> = Vec::with_capacity(gathered.connectors.len());
        for connector in &gathered.connectors {
            let (cells, findings) = placeable_cells(connector);
            for malformation in findings {
                record(&mut malformed, path, malformation);
            }
            placeable.extend(cells);
        }
        let mut connectors: Vec<Connector> = Vec::with_capacity(placeable.len());
        let mut at_slot: HashMap<Slot, Vec<usize>> = HashMap::new();
        for connector in &placeable {
            let connector = finished(connector, &mut issues);
            if let Some(malformation) = malformed_shape(&connector) {
                record(&mut malformed, path, malformation);
                continue;
            }
            let Some(&slot) = slots(&connector).first() else {
                continue;
            };
            let same = at_slot.entry(slot).or_default();
            if same.iter().any(|&i| connectors[i] == connector) {
                continue;
            }
            same.push(connectors.len());
            connectors.push(connector);
        }
        let mut ignored = Vec::new();
        let suppressed = gathered
            .suppressed
            .iter()
            .filter(|connector| !non_finite(&connector.placement.m))
            .map(|connector| finished(connector, &mut ignored))
            .collect();
        for finding in malformed {
            let finding = Issue::from(finding);
            if !issues.contains(&finding) {
                issues.push(finding);
            }
        }
        Extraction {
            connectors,
            suppressed,
            off_lattice: Vec::new(),
            curated: gathered.curated,
            issues,
        }
    }

    fn closure_issues(&self, path: &str, seen: &mut HashSet<String>, out: &mut Vec<Issue>) {
        if !seen.insert(path.to_string()) {
            return;
        }
        let Some(gathered) = self.gathered.get(path) else {
            return;
        };
        out.extend(gathered.issues.iter().cloned());
        for child in &gathered.children {
            self.closure_issues(child, seen, out);
        }
    }

    fn resolve_include(&self, reference: &str) -> Option<String> {
        resolve_reference(self.library, Lod::Standard, reference)
            .or_else(|| resolve_reference(self.shadow, Lod::Standard, reference))
    }

    fn gather(&mut self, path: &str, depth: usize) -> Rc<Gathered> {
        if let Some(found) = self.gathered.get(path) {
            return Rc::clone(found);
        }
        let mut out = Gathered::default();
        if depth > MAX_DEPTH {
            out.issues.push(Issue::TooDeep {
                file: path.to_string(),
            });
            return Rc::new(out);
        }
        if let Some(source) = self.library.source(path) {
            let parsed = ldraw::parse(source);
            if parsed.unparsed > 0 {
                report(&mut out, path, Malformation::Unparsed);
            }
            for line in parsed.lines {
                let Line::Subfile {
                    matrix, reference, ..
                } = line
                else {
                    continue;
                };
                if non_finite(&matrix.m) {
                    report(&mut out, path, Malformation::NonFinite);
                    continue;
                }
                let Some(child) = resolve_reference(self.library, Lod::Standard, &reference) else {
                    continue;
                };
                let inherited = self.gather(&child, depth + 1);
                out.curated |= inherited.curated && child.starts_with(PART_FOLDER);
                out.connectors
                    .extend(inherited.connectors.iter().map(|c| placed(c, &matrix)));
                out.suppressed
                    .extend(inherited.suppressed.iter().map(|c| placed(c, &matrix)));
                out.children.push(child);
            }
        }
        let upstream = Tier {
            source: Source::Shadow,
            status: Status::Verified,
        };
        if let Some(text) = self.shadow.source(path) {
            self.read_tier(path, text, upstream, depth, &mut out);
        }
        if let Some(patches) = &self.patches {
            let tier = Tier {
                source: Source::Patch,
                status: if patches.verified.contains(path) {
                    Status::Verified
                } else {
                    Status::Unverified
                },
            };
            if let Some(text) = patches.files.source(path) {
                self.read_tier(path, text, tier, depth, &mut out);
            }
        }
        let gathered = Rc::new(out);
        self.gathered.insert(path.to_string(), Rc::clone(&gathered));
        gathered
    }

    fn read_tier(&mut self, path: &str, text: &str, tier: Tier, depth: usize, out: &mut Gathered) {
        let metas = parse_metas(text);
        out.curated |= path.starts_with(PART_FOLDER) && !metas.is_empty();
        for parsed in metas {
            match parsed {
                Err(error) => out.issues.push(Issue::Meta {
                    file: path.to_string(),
                    error,
                }),
                Ok(ParsedMeta { meta, ignored }) => {
                    out.issues.extend(ignored.into_iter().map(|parameter| {
                        Issue::IgnoredParameter {
                            file: path.to_string(),
                            parameter,
                        }
                    }));
                    self.apply(path, meta, tier, depth, out);
                }
            }
        }
    }

    fn apply(&mut self, path: &str, meta: Meta, tier: Tier, depth: usize, out: &mut Gathered) {
        match meta {
            Meta::Clear { id } => {
                let (removed, kept): (Vec<Connector>, Vec<Connector>) =
                    out.connectors.drain(..).partition(|connector| {
                        id.as_deref()
                            .is_none_or(|id| connector.id.as_deref() == Some(id))
                    });
                out.connectors = kept;
                out.suppressed.extend(removed);
            }
            Meta::Include {
                reference,
                placement,
                grid,
            } => {
                let Some(target) = self.resolve_include(&reference) else {
                    out.issues.push(Issue::UnresolvedInclude {
                        file: path.to_string(),
                        reference,
                    });
                    return;
                };
                let included = self.gather(&target, depth + 1);
                let offsets = grid.map_or_else(|| vec![[0.0; 3]], |grid| grid.offsets());
                for offset in offsets {
                    let at = placement.then(&shifted(offset));
                    if let Some(malformation) = unplaceable(&at.m) {
                        report(out, path, malformation);
                        continue;
                    }
                    out.connectors
                        .extend(included.connectors.iter().map(|c| placed(c, &at)));
                    out.suppressed
                        .extend(included.suppressed.iter().map(|c| placed(c, &at)));
                }
                out.children.push(target);
            }
            Meta::Snap(connector) => {
                let (cells, findings) = placeable_cells(&connector);
                for malformation in findings {
                    report(out, path, malformation);
                }
                out.connectors
                    .extend(cells.into_iter().map(|cell| Connector {
                        source: tier.source,
                        status: tier.status,
                        ..cell
                    }));
            }
        }
    }
}

fn report(out: &mut Gathered, file: &str, malformation: Malformation) {
    let finding = Issue::from(MalformedGeometry {
        file: file.to_string(),
        malformation,
    });
    if !out.issues.contains(&finding) {
        out.issues.push(finding);
    }
}
