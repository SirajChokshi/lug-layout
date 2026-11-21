use std::fmt;

use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OmrErratum {
    pub model: String,
    pub file: String,
    pub sha256: String,
    pub line: usize,
    pub from: String,
    pub to: String,
    pub summary: String,
}

#[derive(Clone, Copy, Debug)]
pub struct PinnedModel<'a> {
    pub name: &'a str,
    pub file: &'a str,
    pub sha256: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErratumError {
    Repinned {
        line: usize,
        erratum: String,
        palette: String,
    },
    NoSuchLine {
        line: usize,
        lines: usize,
    },
    Mismatch {
        line: usize,
        found: String,
    },
    Repeated {
        line: usize,
    },
}

impl fmt::Display for ErratumError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ErratumError::Repinned {
                line,
                erratum,
                palette,
            } => write!(
                f,
                "the erratum for line {line} pins {erratum}, but the palette pins {palette}; re-check it against the new file"
            ),
            ErratumError::NoSuchLine { line, lines } => {
                write!(f, "erratum for line {line}, but the file has {lines} lines")
            }
            ErratumError::Mismatch { line, found } => write!(
                f,
                "erratum for line {line} expects other text; the line is {found:?}"
            ),
            ErratumError::Repeated { line } => write!(f, "two errata for line {line}"),
        }
    }
}

fn text_field(entry: &Value, index: usize, field: &str) -> Result<String, String> {
    entry[field]
        .as_str()
        .map(str::to_owned)
        .ok_or(format!("erratum {index}: {field} must be a string"))
}

pub fn parse_omr_errata(file: &Value) -> Result<Vec<OmrErratum>, String> {
    let entries = file["errata"].as_array().ok_or("errata must be an array")?;
    entries
        .iter()
        .enumerate()
        .map(|(index, entry)| {
            let line = entry["line"]
                .as_u64()
                .and_then(|line| usize::try_from(line).ok())
                .filter(|&line| line > 0)
                .ok_or(format!("erratum {index}: line must be a positive integer"))?;
            Ok(OmrErratum {
                model: text_field(entry, index, "model")?,
                file: text_field(entry, index, "file")?,
                sha256: text_field(entry, index, "sha256")?,
                line,
                from: text_field(entry, index, "from")?,
                to: text_field(entry, index, "to")?,
                summary: text_field(&entry["evidence"], index, "summary")?,
            })
        })
        .collect()
}

pub fn apply_omr_errata<'e>(
    errata: &'e [OmrErratum],
    model: PinnedModel,
    text: &str,
) -> Result<(String, Vec<&'e OmrErratum>), ErratumError> {
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    let applying: Vec<&OmrErratum> = errata.iter().filter(|e| e.model == model.name).collect();
    let mut replaced: Vec<(usize, String)> = Vec::with_capacity(applying.len());
    for erratum in &applying {
        if erratum.file != model.file || erratum.sha256 != model.sha256 {
            return Err(ErratumError::Repinned {
                line: erratum.line,
                erratum: format!("{} {}", erratum.file, erratum.sha256),
                palette: format!("{} {}", model.file, model.sha256),
            });
        }
        if replaced.iter().any(|&(line, _)| line == erratum.line) {
            return Err(ErratumError::Repeated { line: erratum.line });
        }
        let Some(original) = lines.get(erratum.line - 1) else {
            return Err(ErratumError::NoSuchLine {
                line: erratum.line,
                lines: lines.len(),
            });
        };
        let content = original.trim_end_matches(['\r', '\n']);
        if content != erratum.from {
            return Err(ErratumError::Mismatch {
                line: erratum.line,
                found: content.to_owned(),
            });
        }
        let ending = &original[content.len()..];
        replaced.push((erratum.line, format!("{}{ending}", erratum.to)));
    }
    for (line, text) in &replaced {
        lines[line - 1] = text;
    }
    Ok((lines.concat(), applying))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FILE: &str = "0 FILE station.ldr\r\n1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT\r\n1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT";
    const STATION: PinnedModel = PinnedModel {
        name: "station",
        file: "station.mpd",
        sha256: "aa",
    };

    fn plate() -> OmrErratum {
        OmrErratum {
            model: "station".into(),
            file: "station.mpd".into(),
            sha256: "aa".into(),
            line: 2,
            from: "1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT".into(),
            to: "1 7 470 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT".into(),
            summary: "mirrored pair".into(),
        }
    }

    #[test]
    fn replaces_only_the_named_line_of_the_named_model_and_keeps_every_line_ending() {
        let other = OmrErratum {
            model: "garage".into(),
            line: 1,
            ..plate()
        };
        let errata = [plate(), other];
        let (fixed, applied) = apply_omr_errata(&errata, STATION, FILE).expect("applies");
        assert_eq!(
            fixed,
            "0 FILE station.ldr\r\n1 7 470 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT\r\n1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT"
        );
        assert_eq!(applied, vec![&errata[0]]);
        let (untouched, none) = apply_omr_errata(&errata[..0], STATION, FILE).expect("applies");
        assert_eq!((untouched.as_str(), none.len()), (FILE, 0));
    }

    #[test]
    fn refuses_an_erratum_once_the_model_is_repinned_or_its_line_no_longer_reads_as_recorded() {
        let repinned = PinnedModel {
            sha256: "bb",
            ..STATION
        };
        assert_eq!(
            apply_omr_errata(&[plate()], repinned, FILE).map(|(text, _)| text),
            Err(ErratumError::Repinned {
                line: 2,
                erratum: "station.mpd aa".into(),
                palette: "station.mpd bb".into(),
            })
        );
        let stale = OmrErratum { line: 3, ..plate() };
        assert_eq!(
            apply_omr_errata(&[stale], STATION, FILE).map(|(text, _)| text),
            Err(ErratumError::Mismatch {
                line: 3,
                found: "1 7 470 0 -140 -1 0 0 0 1 0 0 0 -1 3020.DAT".into(),
            })
        );
        let past_the_end = OmrErratum { line: 4, ..plate() };
        assert_eq!(
            apply_omr_errata(&[past_the_end], STATION, FILE).map(|(text, _)| text),
            Err(ErratumError::NoSuchLine { line: 4, lines: 3 })
        );
        assert_eq!(
            apply_omr_errata(&[plate(), plate()], STATION, FILE).map(|(text, _)| text),
            Err(ErratumError::Repeated { line: 2 })
        );
    }

    #[test]
    fn reads_each_erratum_with_its_evidence_summary_and_refuses_a_line_that_is_not_positive() {
        let entry = json!({
            "model": "station",
            "file": "station.mpd",
            "sha256": "aa",
            "line": 2,
            "from": "1 7 460 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT",
            "to": "1 7 470 0 140 -1 0 0 0 1 0 0 0 -1 3020.DAT",
            "evidence": { "kind": "mirror-twin", "summary": "mirrored pair" }
        });
        assert_eq!(
            parse_omr_errata(&json!({ "errata": [entry.clone()] })),
            Ok(vec![plate()])
        );
        let mut zero = entry;
        zero["line"] = json!(0);
        assert_eq!(
            parse_omr_errata(&json!({ "errata": [zero] })),
            Err("erratum 0: line must be a positive integer".into())
        );
    }
}
