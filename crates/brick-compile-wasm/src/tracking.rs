use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};

use brick_compile::Library;

pub struct TrackingLibrary {
    files: HashMap<String, String>,
    absent: HashSet<String>,
    requested: RefCell<BTreeSet<String>>,
}

impl TrackingLibrary {
    pub fn new(files: HashMap<String, String>, absent: HashSet<String>) -> Self {
        TrackingLibrary {
            files,
            absent,
            requested: RefCell::new(BTreeSet::new()),
        }
    }

    pub fn take_requested(&self) -> Vec<String> {
        std::mem::take(&mut *self.requested.borrow_mut())
            .into_iter()
            .collect()
    }
}

impl Library for TrackingLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        if let Some(text) = self.files.get(path) {
            return Some(text.as_str());
        }
        if !self.absent.contains(path) {
            self.requested.borrow_mut().insert(path.to_string());
        }
        None
    }
}
