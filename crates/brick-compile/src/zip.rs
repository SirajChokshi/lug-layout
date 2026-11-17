use miniz_oxide::inflate::decompress_to_vec_with_limit;

const END_OF_CENTRAL_DIRECTORY: u32 = 0x0605_4b50;
const CENTRAL_DIRECTORY_ENTRY: u32 = 0x0201_4b50;
const LOCAL_FILE_HEADER: u32 = 0x0403_4b50;
const END_RECORD_BYTES: usize = 22;
const MAX_ARCHIVE_COMMENT_BYTES: usize = 0xFFFF;
const CENTRAL_ENTRY_FIXED_BYTES: usize = 46;
const LOCAL_HEADER_FIXED_BYTES: usize = 30;
const ENCRYPTED_FLAG: u16 = 1;
const ZIP64_SENTINEL: u32 = u32::MAX;
const METHOD_STORED: u16 = 0;
const METHOD_DEFLATED: u16 = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ZipError {
    NotZip,
    Truncated,
    Zip64,
    UnsupportedMethod { name: String, method: u16 },
    Encrypted { name: String },
    Inflate { name: String },
    Missing { name: String },
}

impl std::fmt::Display for ZipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ZipError::NotZip => write!(f, "not a ZIP archive"),
            ZipError::Truncated => write!(f, "ZIP archive is truncated"),
            ZipError::Zip64 => write!(f, "ZIP64 archives are not supported"),
            ZipError::UnsupportedMethod { name, method } => {
                write!(f, "{name}: unsupported compression method {method}")
            }
            ZipError::Encrypted { name } => write!(f, "{name} is encrypted"),
            ZipError::Inflate { name } => write!(f, "{name}: corrupt deflate stream"),
            ZipError::Missing { name } => write!(f, "{name} is not in the archive"),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ZipEntry {
    pub name: String,
    pub encrypted: bool,
    method: u16,
    compressed_size: usize,
    uncompressed_size: usize,
    local_header_offset: usize,
}

pub struct ZipArchive<'a> {
    bytes: &'a [u8],
    entries: Vec<ZipEntry>,
}

fn add(base: usize, delta: usize) -> Result<usize, ZipError> {
    base.checked_add(delta).ok_or(ZipError::Truncated)
}

fn span(bytes: &[u8], start: usize, length: usize) -> Result<&[u8], ZipError> {
    bytes
        .get(start..add(start, length)?)
        .ok_or(ZipError::Truncated)
}

fn u16_at(bytes: &[u8], base: usize, field: usize) -> Result<u16, ZipError> {
    let b = span(bytes, add(base, field)?, 2)?;
    Ok(u16::from_le_bytes([b[0], b[1]]))
}

fn u32_at(bytes: &[u8], base: usize, field: usize) -> Result<u32, ZipError> {
    let b = span(bytes, add(base, field)?, 4)?;
    Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

fn size(value: u32) -> Result<usize, ZipError> {
    if value == ZIP64_SENTINEL {
        return Err(ZipError::Zip64);
    }
    usize::try_from(value).map_err(|_| ZipError::Zip64)
}

fn end_record_offset(bytes: &[u8]) -> Result<usize, ZipError> {
    if bytes.len() < END_RECORD_BYTES {
        return Err(ZipError::NotZip);
    }
    let last = bytes.len() - END_RECORD_BYTES;
    let first = last.saturating_sub(MAX_ARCHIVE_COMMENT_BYTES);
    (first..=last)
        .rev()
        .find(|&offset| u32_at(bytes, offset, 0) == Ok(END_OF_CENTRAL_DIRECTORY))
        .ok_or(ZipError::NotZip)
}

impl<'a> ZipArchive<'a> {
    pub fn parse(bytes: &'a [u8]) -> Result<Self, ZipError> {
        let end = end_record_offset(bytes)?;
        let count = usize::from(u16_at(bytes, end, 10)?);
        let mut offset = size(u32_at(bytes, end, 16)?)?;
        let mut entries = Vec::with_capacity(count);
        for _ in 0..count {
            if u32_at(bytes, offset, 0)? != CENTRAL_DIRECTORY_ENTRY {
                return Err(ZipError::NotZip);
            }
            let flags = u16_at(bytes, offset, 8)?;
            let name_length = usize::from(u16_at(bytes, offset, 28)?);
            let extra_length = usize::from(u16_at(bytes, offset, 30)?);
            let comment_length = usize::from(u16_at(bytes, offset, 32)?);
            let name_start = add(offset, CENTRAL_ENTRY_FIXED_BYTES)?;
            let name = span(bytes, name_start, name_length)?;
            entries.push(ZipEntry {
                name: String::from_utf8_lossy(name).replace('\\', "/"),
                encrypted: flags & ENCRYPTED_FLAG != 0,
                method: u16_at(bytes, offset, 10)?,
                compressed_size: size(u32_at(bytes, offset, 20)?)?,
                uncompressed_size: size(u32_at(bytes, offset, 24)?)?,
                local_header_offset: size(u32_at(bytes, offset, 42)?)?,
            });
            offset = add(
                add(add(name_start, name_length)?, extra_length)?,
                comment_length,
            )?;
        }
        Ok(ZipArchive { bytes, entries })
    }

    pub fn entries(&self) -> &[ZipEntry] {
        &self.entries
    }

    pub fn entry(&self, name: &str) -> Option<&ZipEntry> {
        self.entries
            .iter()
            .find(|entry| entry.name.eq_ignore_ascii_case(name))
    }

    pub fn read(&self, name: &str) -> Result<Vec<u8>, ZipError> {
        let entry = self.entry(name).ok_or_else(|| ZipError::Missing {
            name: name.to_string(),
        })?;
        if entry.encrypted {
            return Err(ZipError::Encrypted {
                name: entry.name.clone(),
            });
        }
        let header = entry.local_header_offset;
        if u32_at(self.bytes, header, 0)? != LOCAL_FILE_HEADER {
            return Err(ZipError::NotZip);
        }
        let name_length = usize::from(u16_at(self.bytes, header, 26)?);
        let extra_length = usize::from(u16_at(self.bytes, header, 28)?);
        let start = add(
            add(add(header, LOCAL_HEADER_FIXED_BYTES)?, name_length)?,
            extra_length,
        )?;
        let data = span(self.bytes, start, entry.compressed_size)?;
        match entry.method {
            METHOD_STORED => Ok(data.to_vec()),
            METHOD_DEFLATED => {
                decompress_to_vec_with_limit(data, entry.uncompressed_size).map_err(|_| {
                    ZipError::Inflate {
                        name: entry.name.clone(),
                    }
                })
            }
            method => Err(ZipError::UnsupportedMethod {
                name: entry.name.clone(),
                method,
            }),
        }
    }
}
