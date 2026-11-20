use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crate::affine::{Affine, Vec3};
use crate::flatten::{resolve_reference, Library, Lod};
use crate::lattice::{non_finite, record, unplaceable, Malformation, MalformedGeometry};
use crate::ldraw::{self, Line};
use crate::pieces::PieceNumbering;

use super::meta::{parse_metas, Meta, ParsedMeta};
use super::{
    finished, joined_pieces, malformed_shape, placeable_cells, placed, same_connector, slots,
    Connector, Extraction, Issue, Slot, Source, Status, Traced,
};

const MAX_DEPTH: usize = 64;
const PART_FOLDER: &str = "parts/";
const VERIFIED_PATCH: &str = "verified";
const IDENTITY_ROTATION: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
const SUBFILE_LINE: &str = "1";
const SUBFILE_POSITION: std::ops::Range<usize> = 2..5;
const SUBFILE_ORIENTATION: std::ops::Range<usize> = 5..14;
const SUBFILE_REFERENCE: usize = 14;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncludeRefusal {
    NotInLibrary,
    PiecesWouldBeLost,
}

#[derive(Default)]
struct Gathered {
    connectors: Vec<Traced>,
    suppressed: Vec<Traced>,
    issues: Vec<Issue>,
    children: Vec<String>,
    curated: bool,
}

pub fn patch_path(part: &str) -> String {
    if part.contains('/') {
        format!("{part}.dat")
    } else {
        format!("{PART_FOLDER}{part}.dat")
    }
}

pub fn verified_patch_paths(manifest: &serde_json::Value) -> HashSet<String> {
    manifest["patches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["status"] == VERIFIED_PATCH)
        .filter_map(|entry| entry["part"].as_str())
        .map(patch_path)
        .collect()
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
    numbering: PieceNumbering<'a, L>,
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
            numbering: PieceNumbering::new(library),
        }
    }

    pub fn patched(mut self, patches: ShadowPatches<'a, S>) -> Self {
        self.patches = Some(patches);
        self
    }

    pub fn snaps(&mut self, path: &str) -> Extraction {
        let gathered = self.gather(path, 0);
        let pieces = self.numbering.map(path);
        let mut issues = Vec::new();
        let mut seen = HashSet::new();
        self.closure_issues(path, &mut seen, &mut issues);
        let mut malformed = Vec::new();
        let mut placeable: Vec<Traced> = Vec::with_capacity(gathered.connectors.len());
        for traced in &gathered.connectors {
            let (cells, findings) = placeable_cells(&traced.connector);
            for malformation in findings {
                record(&mut malformed, path, malformation);
            }
            placeable.extend(cells.into_iter().map(|cell| Traced {
                connector: cell,
                trail: traced.trail.clone(),
            }));
        }
        let mut connectors: Vec<Connector> = Vec::with_capacity(placeable.len());
        let mut at_slot: HashMap<Slot, Vec<usize>> = HashMap::new();
        for traced in &placeable {
            let connector = Connector {
                pieces: vec![pieces.piece(&traced.trail)],
                ..finished(&traced.connector, &mut issues)
            };
            if let Some(malformation) = malformed_shape(&connector) {
                record(&mut malformed, path, malformation);
                continue;
            }
            let Some(&slot) = slots(&connector).first() else {
                continue;
            };
            let same = at_slot.entry(slot).or_default();
            if let Some(&kept) = same
                .iter()
                .find(|&&i| same_connector(&connectors[i], &connector))
            {
                connectors[kept].pieces =
                    joined_pieces(&connectors[kept].pieces, &connector.pieces);
                continue;
            }
            same.push(connectors.len());
            connectors.push(connector);
        }
        let mut ignored = Vec::new();
        let suppressed = gathered
            .suppressed
            .iter()
            .filter(|traced| !non_finite(&traced.connector.placement.m))
            .map(|traced| finished(&traced.connector, &mut ignored))
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

    pub fn inheritance_includes(&mut self, path: &str) -> Result<Vec<String>, IncludeRefusal> {
        let library = self.library;
        let text = library.source(path).ok_or(IncludeRefusal::NotInLibrary)?;
        let mut includes = Vec::new();
        for line in text.lines() {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.first() != Some(&SUBFILE_LINE) || tokens.len() <= SUBFILE_REFERENCE {
                continue;
            }
            let reference = tokens[SUBFILE_REFERENCE..].join(" ");
            let Some(child) = resolve_reference(library, Lod::Standard, &reference) else {
                continue;
            };
            let inherited = self.gather(&child, 1);
            if inherited.connectors.is_empty() && inherited.suppressed.is_empty() {
                continue;
            }
            includes.push(format!(
                "0 !LDCAD SNAP_INCL [ref={reference}] [pos={}] [ori={}]",
                tokens[SUBFILE_POSITION].join(" "),
                tokens[SUBFILE_ORIENTATION].join(" ")
            ));
        }
        if !includes.is_empty() && !self.numbering.map(path).is_empty() {
            return Err(IncludeRefusal::PiecesWouldBeLost);
        }
        Ok(includes)
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
            let mut next_ordinal: u32 = 0;
            for line in parsed.lines {
                let Line::Subfile {
                    matrix, reference, ..
                } = line
                else {
                    continue;
                };
                let ordinal = next_ordinal;
                next_ordinal += 1;
                if non_finite(&matrix.m) {
                    report(&mut out, path, Malformation::NonFinite);
                    continue;
                }
                let Some(child) = resolve_reference(self.library, Lod::Standard, &reference) else {
                    continue;
                };
                let inherited = self.gather(&child, depth + 1);
                out.curated |= inherited.curated && child.starts_with(PART_FOLDER);
                out.connectors.extend(
                    inherited
                        .connectors
                        .iter()
                        .map(|c| c.through(ordinal, &matrix)),
                );
                out.suppressed.extend(
                    inherited
                        .suppressed
                        .iter()
                        .map(|c| c.through(ordinal, &matrix)),
                );
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
                let (removed, kept): (Vec<Traced>, Vec<Traced>) =
                    out.connectors.drain(..).partition(|traced| {
                        id.as_deref()
                            .is_none_or(|id| traced.connector.id.as_deref() == Some(id))
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
                    out.connectors.extend(
                        included
                            .connectors
                            .iter()
                            .map(|c| Traced::declared(placed(&c.connector, &at))),
                    );
                    out.suppressed.extend(
                        included
                            .suppressed
                            .iter()
                            .map(|c| Traced::declared(placed(&c.connector, &at))),
                    );
                }
                out.children.push(target);
            }
            Meta::Snap(connector) => {
                let (cells, findings) = placeable_cells(&connector);
                for malformation in findings {
                    report(out, path, malformation);
                }
                out.connectors.extend(cells.into_iter().map(|cell| {
                    Traced::declared(Connector {
                        source: tier.source,
                        status: tier.status,
                        ..cell
                    })
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
