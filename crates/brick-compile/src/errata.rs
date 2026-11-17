#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LineErratum<'a> {
    pub line: usize,
    pub from: &'a str,
    pub to: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ErratumError {
    NoSuchLine { line: usize, lines: usize },
    Mismatch { line: usize, found: String },
    Repeated { line: usize },
}

impl std::fmt::Display for ErratumError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ErratumError::NoSuchLine { line, lines } => {
                write!(f, "erratum for line {line}, but the file has {lines} lines")
            }
            ErratumError::Mismatch { line, found } => {
                write!(
                    f,
                    "erratum for line {line} expects other text; the line is {found:?}"
                )
            }
            ErratumError::Repeated { line } => write!(f, "two errata for line {line}"),
        }
    }
}

pub fn apply_line_errata(text: &str, errata: &[LineErratum]) -> Result<String, ErratumError> {
    let mut lines: Vec<&str> = text.split_inclusive('\n').collect();
    let mut replaced: Vec<String> = Vec::with_capacity(errata.len());
    let mut targets: Vec<(usize, usize)> = Vec::with_capacity(errata.len());
    for erratum in errata {
        if targets.iter().any(|&(line, _)| line == erratum.line) {
            return Err(ErratumError::Repeated { line: erratum.line });
        }
        let Some(original) = erratum
            .line
            .checked_sub(1)
            .and_then(|index| lines.get(index))
        else {
            return Err(ErratumError::NoSuchLine {
                line: erratum.line,
                lines: lines.len(),
            });
        };
        let content = original.trim_end_matches(['\r', '\n']);
        if content != erratum.from {
            return Err(ErratumError::Mismatch {
                line: erratum.line,
                found: content.to_string(),
            });
        }
        let ending = &original[content.len()..];
        replaced.push(format!("{}{ending}", erratum.to));
        targets.push((erratum.line, replaced.len() - 1));
    }
    for &(line, index) in &targets {
        lines[line - 1] = &replaced[index];
    }
    Ok(lines.concat())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "0 FILE a.ldr\r\n1 7 460 0 140 1 0 0 0 1 0 0 0 1 3020.dat\r\n1 7 470 0 -140 1 0 0 0 1 0 0 0 1 3020.dat";

    #[test]
    fn replaces_exactly_the_named_line_and_keeps_every_line_ending() {
        let fixed = apply_line_errata(
            FILE,
            &[LineErratum {
                line: 2,
                from: "1 7 460 0 140 1 0 0 0 1 0 0 0 1 3020.dat",
                to: "1 7 470 0 140 1 0 0 0 1 0 0 0 1 3020.dat",
            }],
        );
        assert_eq!(
            fixed.as_deref(),
            Ok("0 FILE a.ldr\r\n1 7 470 0 140 1 0 0 0 1 0 0 0 1 3020.dat\r\n1 7 470 0 -140 1 0 0 0 1 0 0 0 1 3020.dat")
        );
    }

    #[test]
    fn refuses_an_erratum_whose_line_no_longer_reads_as_recorded() {
        let stale = LineErratum {
            line: 3,
            from: "1 7 460 0 140 1 0 0 0 1 0 0 0 1 3020.dat",
            to: "1 7 470 0 140 1 0 0 0 1 0 0 0 1 3020.dat",
        };
        assert_eq!(
            apply_line_errata(FILE, &[stale]),
            Err(ErratumError::Mismatch {
                line: 3,
                found: "1 7 470 0 -140 1 0 0 0 1 0 0 0 1 3020.dat".into(),
            })
        );
        assert_eq!(
            apply_line_errata(FILE, &[LineErratum { line: 4, ..stale }]),
            Err(ErratumError::NoSuchLine { line: 4, lines: 3 })
        );
        assert_eq!(
            apply_line_errata(
                FILE,
                &[
                    LineErratum { line: 2, ..stale },
                    LineErratum { line: 2, ..stale }
                ]
            ),
            Err(ErratumError::Repeated { line: 2 })
        );
    }
}
