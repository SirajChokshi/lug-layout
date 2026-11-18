#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};

use brick_compile::Library;

#[derive(Default)]
pub struct TrackingLibrary {
    key: String,
    files: HashMap<String, String>,
    absent: HashSet<String>,
    requested: RefCell<BTreeSet<String>>,
}

impl TrackingLibrary {
    pub fn extend(
        &mut self,
        key: &str,
        files: impl IntoIterator<Item = (String, String)>,
        absent: impl IntoIterator<Item = String>,
    ) {
        if self.key != key {
            *self = TrackingLibrary {
                key: key.to_string(),
                ..TrackingLibrary::default()
            };
        }
        self.files.extend(files);
        self.absent.extend(absent);
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
