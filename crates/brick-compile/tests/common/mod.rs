use std::collections::HashMap;
use std::fs;
use std::path::Path;

use brick_compile::Library;

pub struct MemoryLibrary(pub HashMap<String, String>);

impl Library for MemoryLibrary {
    fn source(&self, path: &str) -> Option<&str> {
        self.0.get(path).map(String::as_str)
    }
}

pub fn fixture_library() -> MemoryLibrary {
    restored_library("ldraw")
}

pub fn restored_library(closure: &str) -> MemoryLibrary {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../.cache")
        .join(closure);
    let mut files = HashMap::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in fs::read_dir(&dir)
            .expect("pinned LDraw inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`")
        {
            let path = entry.expect("fixture entry").path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let key = path
                .strip_prefix(&root)
                .expect("fixture under root")
                .to_string_lossy()
                .replace('\\', "/")
                .to_lowercase();
            let bytes = fs::read(&path).expect("fixture file is readable");
            files.insert(key, String::from_utf8_lossy(&bytes).into_owned());
        }
    }
    MemoryLibrary(files)
}
