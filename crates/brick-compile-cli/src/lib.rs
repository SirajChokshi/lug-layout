use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

use brick_compile::connect::SectionVocabulary;
use brick_compile::flatten::Library;
use serde_json::Value;

const COMMENTED_SNAP: &str = "0 //!LDCAD SNAP_";
const LIVE_SNAP: &str = "0 !LDCAD SNAP_";
const PART_FOLDER: &str = "parts/";
const VERIFIED: &str = "verified";

pub fn patch_path(part: &str) -> String {
    if part.contains('/') {
        format!("{part}.dat")
    } else {
        format!("{PART_FOLDER}{part}.dat")
    }
}

pub fn verified_patch_paths(manifest: &Value) -> HashSet<String> {
    manifest["patches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["status"] == VERIFIED)
        .filter_map(|entry| entry["part"].as_str())
        .map(patch_path)
        .collect()
}

pub struct LazyLibrary {
    root: PathBuf,
    revive_commented_snaps: bool,
    loaded: RefCell<HashMap<String, Option<&'static str>>>,
}

impl LazyLibrary {
    pub fn new(root: PathBuf) -> Self {
        LazyLibrary {
            root,
            revive_commented_snaps: false,
            loaded: RefCell::new(HashMap::new()),
        }
    }

    pub fn reviving_commented_snaps(root: PathBuf) -> Self {
        LazyLibrary {
            revive_commented_snaps: true,
            ..LazyLibrary::new(root)
        }
    }
}

impl Library for LazyLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        if let Some(found) = self.loaded.borrow().get(path) {
            return *found;
        }
        let found: Option<&'static str> = fs::read(self.root.join(path)).ok().map(|bytes| {
            let text = String::from_utf8_lossy(&bytes).into_owned();
            let text = if self.revive_commented_snaps {
                text.replace(COMMENTED_SNAP, LIVE_SNAP)
            } else {
                text
            };
            &*Box::leak(text.into_boxed_str())
        });
        self.loaded.borrow_mut().insert(path.to_string(), found);
        found
    }
}

pub fn shadow_texts(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("dat"))
            {
                if let Ok(bytes) = fs::read(&path) {
                    out.push(String::from_utf8_lossy(&bytes).into_owned());
                }
            }
        }
    }
    out
}

pub fn read_section_vocabulary(path: &Path) -> Result<SectionVocabulary, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    SectionVocabulary::from_json(&value).map_err(|e| format!("{}: {e}", path.display()))
}
