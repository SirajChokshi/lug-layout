#![forbid(unsafe_code)]

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::rc::Rc;

use brick_compile::ldraw::{parse, LdrawFile};
use brick_compile::Library;

#[derive(Default)]
pub struct TrackingLibrary {
    key: String,
    files: HashMap<String, String>,
    absent: HashSet<String>,
    requested: RefCell<BTreeSet<String>>,
    parsed: RefCell<HashMap<String, Rc<LdrawFile>>>,
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

    fn parsed(&self, path: &str) -> Option<Rc<LdrawFile>> {
        if let Some(file) = self.parsed.borrow().get(path) {
            return Some(Rc::clone(file));
        }
        let file = Rc::new(parse(self.source(path)?));
        self.parsed
            .borrow_mut()
            .insert(path.to_string(), Rc::clone(&file));
        Some(file)
    }
}
