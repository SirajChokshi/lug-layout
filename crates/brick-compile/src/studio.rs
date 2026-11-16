use std::collections::BTreeMap;

use serde_json::Value;

use crate::ldraw::normalize_reference;
use crate::zip::{ZipArchive, ZipError};

pub const MODEL_ENTRIES: [&str; 2] = ["modelv2.ldr", "model.ldr"];
const METADATA_ENTRY: &str = "model2.ldr";
const INFO_ENTRY: &str = ".info";
const CUSTOM_PARTS_DIRECTORY: &str = "customparts/";
const PART_FILE_EXTENSION: &str = ".dat";
const STUDIO_PART_LINE: &str = "11";
const STUDIO_ONLY_FIELDS: usize = 3;
const STUDIO_PART_MIN_TOKENS: usize = 18;
const BYTE_ORDER_MARK: char = '\u{feff}';
const FILE_META: &str = "0 FILE ";
const BRICKLINK_ITEM_META: &str = "BL_Item_No";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StudioArchive {
    pub entry: String,
    pub ldraw: String,
    pub studio_version: Option<String>,
    pub converted_lines: usize,
    pub unconverted_lines: Vec<usize>,
    pub bricklink_ids: BTreeMap<String, String>,
    pub custom_parts: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StudioError {
    NotZip(ZipError),
    Encrypted,
    NoModel { entries: Vec<String> },
}

impl std::fmt::Display for StudioError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StudioError::NotZip(error) => write!(f, "not a readable Studio .io file: {error}"),
            StudioError::Encrypted => write!(
                f,
                "this .io file is an encrypted archive written by an older Studio; open it in a current Studio, save it again, and import the new file"
            ),
            StudioError::NoModel { entries } => write!(
                f,
                "the .io file has no {} (entries: {})",
                MODEL_ENTRIES.join(" or "),
                entries.join(", ")
            ),
        }
    }
}

fn text(bytes: &[u8]) -> String {
    let decoded = String::from_utf8_lossy(bytes);
    decoded
        .strip_prefix(BYTE_ORDER_MARK)
        .unwrap_or(&decoded)
        .to_string()
}

pub fn standard_line(line: &str) -> Option<String> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.first() != Some(&STUDIO_PART_LINE) || tokens.len() < STUDIO_PART_MIN_TOKENS {
        return None;
    }
    let mut out = vec!["1", tokens[1]];
    out.extend(&tokens[2 + STUDIO_ONLY_FIELDS..]);
    Some(out.join(" "))
}

fn to_standard_ldraw(source: &str) -> (String, usize, Vec<usize>) {
    let mut out = String::with_capacity(source.len());
    let mut converted = 0;
    let mut unconverted = Vec::new();
    for (index, line) in source.lines().enumerate() {
        match standard_line(line) {
            Some(standard) => {
                converted += 1;
                out.push_str(&standard);
            }
            None => {
                if line.split_whitespace().next() == Some(STUDIO_PART_LINE) {
                    unconverted.push(index + 1);
                }
                out.push_str(line);
            }
        }
        out.push('\n');
    }
    (out, converted, unconverted)
}

fn bricklink_ids(metadata: &str) -> BTreeMap<String, String> {
    let mut ids = BTreeMap::new();
    let mut section: Option<String> = None;
    for line in metadata.lines() {
        if let Some(name) = line.strip_prefix(FILE_META) {
            section = Some(normalize_reference(name));
            continue;
        }
        let mut tokens = line.split_whitespace();
        if tokens.next() != Some("0") || tokens.next() != Some(BRICKLINK_ITEM_META) {
            continue;
        }
        if let (Some(name), Some(id)) = (&section, tokens.next()) {
            ids.insert(name.clone(), id.to_lowercase());
        }
    }
    ids
}

fn custom_parts(archive: &ZipArchive) -> Vec<String> {
    let mut parts: Vec<String> = archive
        .entries()
        .iter()
        .filter_map(|entry| {
            let name = entry.name.to_lowercase();
            let file = name.strip_prefix(CUSTOM_PARTS_DIRECTORY)?;
            (!file.contains('/') && file.ends_with(PART_FILE_EXTENSION)).then(|| file.to_string())
        })
        .collect();
    parts.sort();
    parts
}

fn studio_version(archive: &ZipArchive) -> Option<String> {
    let info: Value = serde_json::from_str(&text(&archive.read(INFO_ENTRY).ok()?)).ok()?;
    info["version"].as_str().map(str::to_string)
}

pub fn read_io(bytes: &[u8]) -> Result<StudioArchive, StudioError> {
    let archive = ZipArchive::parse(bytes).map_err(StudioError::NotZip)?;
    if archive.entries().iter().any(|entry| entry.encrypted) {
        return Err(StudioError::Encrypted);
    }
    let entry = MODEL_ENTRIES
        .iter()
        .find_map(|name| archive.entry(name))
        .ok_or_else(|| StudioError::NoModel {
            entries: archive.entries().iter().map(|e| e.name.clone()).collect(),
        })?;
    let source = text(&archive.read(&entry.name).map_err(StudioError::NotZip)?);
    let (ldraw, converted_lines, unconverted_lines) = to_standard_ldraw(&source);
    let metadata = archive
        .read(METADATA_ENTRY)
        .map(|bytes| text(&bytes))
        .unwrap_or_default();
    Ok(StudioArchive {
        entry: entry.name.clone(),
        ldraw,
        studio_version: studio_version(&archive),
        converted_lines,
        unconverted_lines,
        bricklink_ids: bricklink_ids(&metadata),
        custom_parts: custom_parts(&archive),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use miniz_oxide::deflate::compress_to_vec;

    const ENCRYPTED_FLAG: u16 = 1;
    const DEFLATED: u16 = 8;

    fn archive(files: &[(&str, &str)], flags: u16) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in files {
            let data = compress_to_vec(body.as_bytes(), 6);
            let offset = u32::try_from(out.len()).unwrap();
            let sizes = [data.len(), body.len()].map(|n| u32::try_from(n).unwrap());
            let name_length = u16::try_from(name.len()).unwrap();
            out.extend(0x0403_4b50u32.to_le_bytes());
            out.extend([20, 0]);
            out.extend(flags.to_le_bytes());
            out.extend(DEFLATED.to_le_bytes());
            out.extend([0; 8]);
            out.extend(sizes[0].to_le_bytes());
            out.extend(sizes[1].to_le_bytes());
            out.extend(name_length.to_le_bytes());
            out.extend([0, 0]);
            out.extend(name.as_bytes());
            out.extend(&data);
            central.extend(0x0201_4b50u32.to_le_bytes());
            central.extend([20, 0, 20, 0]);
            central.extend(flags.to_le_bytes());
            central.extend(DEFLATED.to_le_bytes());
            central.extend([0; 8]);
            central.extend(sizes[0].to_le_bytes());
            central.extend(sizes[1].to_le_bytes());
            central.extend(name_length.to_le_bytes());
            central.extend([0; 12]);
            central.extend(offset.to_le_bytes());
            central.extend(name.as_bytes());
        }
        let directory_offset = u32::try_from(out.len()).unwrap();
        let count = u16::try_from(files.len()).unwrap();
        let directory_size = u32::try_from(central.len()).unwrap();
        out.extend(central);
        out.extend(0x0605_4b50u32.to_le_bytes());
        out.extend([0; 4]);
        out.extend(count.to_le_bytes());
        out.extend(count.to_le_bytes());
        out.extend(directory_size.to_le_bytes());
        out.extend(directory_offset.to_le_bytes());
        out.extend([0, 0]);
        out
    }

    const MODELV2: &str = "\u{feff}0 FILE m.io\n11 15 3 False 0 -597.7588 -94.99998 -262.0742 0 0 -1 0 1 0 1 0 0 60219.dat\n11 4 9 True 0 1 2 3 1 0 0 0 1 0 0 0 1 Left Wing\n";
    const MODEL2: &str = "0 FILE 4079b.dat\n0 Name:  4079b\n0 BL_Item_No 4079b\n0 FILE 3001.dat\n0 BL_Item_No 3001\n";

    #[test]
    fn studio_part_lines_become_standard_lines_with_studio_fields_dropped() {
        let read = read_io(&archive(
            &[("modelv2.ldr", MODELV2), ("model2.ldr", MODEL2)],
            0,
        ))
        .unwrap();
        assert_eq!(read.entry, "modelv2.ldr");
        assert_eq!(
            read.ldraw,
            "0 FILE m.io\n1 15 -597.7588 -94.99998 -262.0742 0 0 -1 0 1 0 1 0 0 60219.dat\n1 4 1 2 3 1 0 0 0 1 0 0 0 1 Left Wing\n"
        );
        assert_eq!(read.converted_lines, 2);
        assert_eq!(
            read.bricklink_ids.get("4079b.dat").map(String::as_str),
            Some("4079b")
        );
    }

    #[test]
    fn falls_back_to_model_ldr_and_lists_custom_parts() {
        let read = read_io(&archive(
            &[
                ("model.ldr", "1 4 0 0 0 1 0 0 0 1 0 0 0 1 legleft.dat\n"),
                ("CustomParts/legLeft.dat", "0 custom\n"),
                ("CustomParts/s/legs01.dat", "0 sub\n"),
                ("CustomParts/connectivity/legleft.conn", "x"),
            ],
            0,
        ))
        .unwrap();
        assert_eq!(read.entry, "model.ldr");
        assert_eq!(read.converted_lines, 0);
        assert_eq!(read.custom_parts, vec!["legleft.dat".to_string()]);
    }

    #[test]
    fn encrypted_archives_are_rejected_before_any_entry_is_read() {
        let error = read_io(&archive(&[("model.ldr", "0 x\n")], ENCRYPTED_FLAG)).unwrap_err();
        assert_eq!(error, StudioError::Encrypted);
        assert!(error.to_string().contains("save it again"));
    }

    #[test]
    fn archives_without_a_model_entry_name_what_they_hold() {
        let error = read_io(&archive(&[("thumbnail.png", "png")], 0)).unwrap_err();
        assert_eq!(
            error,
            StudioError::NoModel {
                entries: vec!["thumbnail.png".to_string()]
            }
        );
        assert!(matches!(
            read_io(b"0 FILE plain.ldr\n"),
            Err(StudioError::NotZip(ZipError::NotZip))
        ));
    }
}
