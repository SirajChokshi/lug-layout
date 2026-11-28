mod budget;
mod document;
mod element;
mod file;
mod format;
mod groups;
mod layers;
mod node;
mod reader;
mod references;
mod values;

pub use budget::{read_bbb, BlueBrickBudget, BudgetedPart};
pub use document::*;
pub use file::{BlueBrickFile, NEWEST_BUDGET_FORMAT};
pub use format::{Format, NEWEST_FORMAT};
pub use layers::{
    AreaLayerReader, BrickLayerReader, GridLayerReader, LayerContext, LayerRead, LayerReader,
    Reference, RulerLayerReader, TextLayerReader,
};
pub use node::{FromNode, Node};
pub use reader::BlueBrickReader;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlueBrickError {
    NotXml {
        file: BlueBrickFile,
        problem: String,
    },
    Unrecognized {
        file: BlueBrickFile,
        problem: String,
    },
    NewerVersion {
        file: BlueBrickFile,
        version: u32,
    },
    Malformed {
        path: String,
        problem: String,
    },
}

impl BlueBrickError {
    pub fn kind(&self) -> &'static str {
        match self {
            BlueBrickError::NotXml { .. } => "notXml",
            BlueBrickError::Unrecognized {
                file: BlueBrickFile::Map,
                ..
            } => "notMap",
            BlueBrickError::Unrecognized {
                file: BlueBrickFile::Budget,
                ..
            } => "notBudget",
            BlueBrickError::NewerVersion { .. } => "newerVersion",
            BlueBrickError::Malformed { .. } => "malformed",
        }
    }
}

impl std::fmt::Display for BlueBrickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlueBrickError::NotXml { file, problem } => write!(
                f,
                "not a BlueBrick {}: the file isn't well-formed XML, because {problem}",
                file.noun()
            ),
            BlueBrickError::Unrecognized { file, problem } => {
                write!(f, "not a BlueBrick {}: {problem}", file.noun())
            }
            BlueBrickError::NewerVersion { file, version } => write!(
                f,
                "this {} was saved by a newer BlueBrick (data version {version}); this reader knows versions up to {}",
                file.noun(),
                file.newest_version()
            ),
            BlueBrickError::Malformed { path, problem } => {
                write!(f, "the BlueBrick file is damaged: {path} {problem}")
            }
        }
    }
}

pub fn read_bbm(bytes: &[u8]) -> Result<BlueBrickMap, BlueBrickError> {
    BlueBrickReader::default().read(bytes)
}
