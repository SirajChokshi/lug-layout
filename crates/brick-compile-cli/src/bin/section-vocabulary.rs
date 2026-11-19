use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use brick_compile::connect::SectionVocabulary;
use brick_compile_cli::shadow_texts;

fn run() -> Result<(), String> {
    let mut values = HashMap::new();
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        values.insert(flag, raw.next().unwrap_or_default());
    }
    let take = |k: &str| values.get(k).cloned().ok_or(format!("missing {k}"));
    let shadow = PathBuf::from(take("--shadow")?);
    let texts = shadow_texts(&shadow);
    if texts.is_empty() {
        return Err(format!("{} holds no shadow files", shadow.display()));
    }
    let vocabulary = SectionVocabulary::from_metas(texts.iter().map(String::as_str));
    let text = serde_json::to_string(&vocabulary.to_json()).map_err(|e| e.to_string())?;
    let out = take("--out")?;
    fs::write(&out, text).map_err(|e| format!("{out}: {e}"))
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("section-vocabulary: {message}");
            ExitCode::FAILURE
        }
    }
}
