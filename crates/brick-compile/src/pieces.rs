use std::collections::HashMap;
use std::rc::Rc;

use crate::flatten::{resolve_reference, Library, Lod};
use crate::ldraw::{self, Line};

pub const NO_PIECE: u16 = 0;
const MAX_DEPTH: usize = 64;
const UNOFFICIAL_PREFIX: &str = "unofficial_";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Part,
    Shortcut,
    Other,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PieceMap {
    numbered: HashMap<Vec<u32>, u16>,
}

impl PieceMap {
    pub fn piece(&self, trail: &[u32]) -> u16 {
        (1..=trail.len())
            .find_map(|end| self.numbered.get(&trail[..end]).copied())
            .unwrap_or(NO_PIECE)
    }

    pub fn numbered(&self, trail: &[u32]) -> Option<u16> {
        self.numbered.get(trail).copied()
    }

    pub fn len(&self) -> usize {
        self.numbered.len()
    }

    pub fn is_empty(&self) -> bool {
        self.numbered.is_empty()
    }
}

pub struct PieceNumbering<'a, L: Library + ?Sized> {
    library: &'a L,
    kinds: HashMap<String, Kind>,
    children: HashMap<String, Rc<Vec<Option<String>>>>,
}

fn kind_of_org(org: Option<&str>) -> Kind {
    let first = org
        .and_then(|org| org.split_whitespace().next())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match first.trim_start_matches(UNOFFICIAL_PREFIX) {
        "part" => Kind::Part,
        "shortcut" => Kind::Shortcut,
        _ => Kind::Other,
    }
}

impl<'a, L: Library + ?Sized> PieceNumbering<'a, L> {
    pub fn new(library: &'a L) -> Self {
        PieceNumbering {
            library,
            kinds: HashMap::new(),
            children: HashMap::new(),
        }
    }

    pub fn map(&mut self, path: &str) -> PieceMap {
        let mut map = PieceMap::default();
        let mut trail = Vec::new();
        let mut next = NO_PIECE;
        self.walk(path, &mut trail, &mut next, &mut map, 0);
        map
    }

    fn kind(&mut self, path: &str) -> Kind {
        if let Some(&kind) = self.kinds.get(path) {
            return kind;
        }
        let kind = self.library.source(path).map_or(Kind::Other, |source| {
            kind_of_org(ldraw::parse(source).header.ldraw_org.as_deref())
        });
        self.kinds.insert(path.to_string(), kind);
        kind
    }

    fn children(&mut self, path: &str) -> Rc<Vec<Option<String>>> {
        if let Some(found) = self.children.get(path) {
            return Rc::clone(found);
        }
        let children: Vec<Option<String>> = self
            .library
            .source(path)
            .map(|source| {
                ldraw::parse(source)
                    .lines
                    .into_iter()
                    .filter_map(|line| match line {
                        Line::Subfile { reference, .. } => {
                            Some(resolve_reference(self.library, Lod::Standard, &reference))
                        }
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let children = Rc::new(children);
        self.children.insert(path.to_string(), Rc::clone(&children));
        children
    }

    fn holds_pieces(&mut self, path: &str) -> bool {
        self.children(path)
            .iter()
            .flatten()
            .any(|child| self.kind(child) != Kind::Other)
    }

    fn walk(
        &mut self,
        path: &str,
        trail: &mut Vec<u32>,
        next: &mut u16,
        map: &mut PieceMap,
        depth: usize,
    ) {
        if depth > MAX_DEPTH {
            return;
        }
        let children = self.children(path);
        for (ordinal, child) in children.iter().enumerate() {
            let Some(child) = child else {
                continue;
            };
            trail.push(ordinal as u32);
            match self.kind(child) {
                Kind::Shortcut => self.walk(child, trail, next, map, depth + 1),
                Kind::Part if self.holds_pieces(child) => {
                    self.walk(child, trail, next, map, depth + 1)
                }
                Kind::Part => {
                    *next += 1;
                    map.numbered.insert(trail.clone(), *next);
                }
                Kind::Other => {}
            }
            trail.pop();
        }
    }
}
