use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::affine::{Affine, Vec3};
use crate::flatten::{resolve_reference, Library, Lod};
use crate::ldraw::{self, Line};

use super::meta::{parse_metas, Meta, ParsedMeta};
use super::{finished, placed, slots, Connector, Extraction, Issue, Slot};

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

pub struct ShadowSnaps<'a, L: Library + ?Sized, S: Library + ?Sized> {
    library: &'a L,
    shadow: &'a S,
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
            gathered: HashMap::new(),
        }
    }

    pub fn snaps(&mut self, path: &str) -> Extraction {
        let gathered = self.gather(path, 0);
        let mut issues = Vec::new();
        let mut seen = HashSet::new();
        self.closure_issues(path, &mut seen, &mut issues);
        let mut connectors: Vec<Connector> = Vec::with_capacity(gathered.connectors.len());
        let mut at_slot: HashMap<Slot, Vec<usize>> = HashMap::new();
        for connector in &gathered.connectors {
            let connector = finished(connector, &mut issues);
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
            .map(|connector| finished(connector, &mut ignored))
            .collect();
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
            for line in ldraw::parse(source).lines {
                let Line::Subfile {
                    matrix, reference, ..
                } = line
                else {
                    continue;
                };
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
        if let Some(shadow) = self.shadow.source(path) {
            let metas = parse_metas(shadow);
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
                        self.apply(path, meta, depth, &mut out);
                    }
                }
            }
        }
        let gathered = Rc::new(out);
        self.gathered.insert(path.to_string(), Rc::clone(&gathered));
        gathered
    }

    fn apply(&mut self, path: &str, meta: Meta, depth: usize, out: &mut Gathered) {
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
                    out.connectors
                        .extend(included.connectors.iter().map(|c| placed(c, &at)));
                    out.suppressed
                        .extend(included.suppressed.iter().map(|c| placed(c, &at)));
                }
                out.children.push(target);
            }
            Meta::Snap(connector) => out.connectors.push(connector),
        }
    }
}
