use std::cell::RefCell;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use brick_compile::connect::SectionVocabulary;
pub use brick_compile::connect::{patch_path, verified_patch_paths};
use brick_compile::flatten::Library;

pub mod errata;

const COMMENTED_SNAP: &str = "0 //!LDCAD SNAP_";
const LIVE_SNAP: &str = "0 !LDCAD SNAP_";

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

pub const PART_FOLDER: &str = "parts";
pub const PART_EXTENSION: &str = ".dat";

pub struct DirectoryLibrary {
    files: HashMap<String, PathBuf>,
    read: RefCell<HashMap<String, Option<&'static str>>>,
}

impl DirectoryLibrary {
    pub fn new(root: &Path) -> Result<Self, String> {
        let mut files = HashMap::new();
        let mut folders = vec![root.to_path_buf()];
        while let Some(folder) = folders.pop() {
            for entry in fs::read_dir(&folder).map_err(|e| format!("{}: {e}", folder.display()))? {
                let path = entry.map_err(|e| e.to_string())?.path();
                if path.is_dir() {
                    folders.push(path);
                    continue;
                }
                let key = path
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/")
                    .to_lowercase();
                files.entry(key).or_insert(path);
            }
        }
        Ok(DirectoryLibrary {
            files,
            read: RefCell::new(HashMap::new()),
        })
    }
}

impl Library for DirectoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        if let Some(&text) = self.read.borrow().get(path) {
            return text;
        }
        let text = self
            .files
            .get(path)
            .and_then(|file| fs::read(file).ok())
            .map(|bytes| {
                let text: &'static str = Box::leak(
                    String::from_utf8_lossy(&bytes)
                        .into_owned()
                        .into_boxed_str(),
                );
                text
            });
        self.read.borrow_mut().insert(path.to_string(), text);
        text
    }
}

pub fn library_parts(library: &DirectoryLibrary) -> Vec<String> {
    let prefix = format!("{PART_FOLDER}/");
    let mut parts: Vec<String> = library
        .files
        .keys()
        .filter_map(|path| path.strip_prefix(&prefix))
        .filter(|name| !name.contains('/') && name.ends_with(PART_EXTENSION))
        .map(str::to_string)
        .collect();
    parts.sort();
    parts
}

pub fn strings(palette: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    palette[key]
        .as_array()
        .ok_or(format!("palette.{key} must be an array"))?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or(format!("palette.{key} holds a non-string"))
        })
        .collect()
}

pub fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

pub fn read_section_vocabulary(path: &Path) -> Result<SectionVocabulary, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))?;
    SectionVocabulary::from_json(&value).map_err(|e| format!("{}: {e}", path.display()))
}
