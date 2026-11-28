mod document;
mod element;
mod format;
mod groups;
mod layers;
mod node;
mod reader;
mod references;
mod values;

pub use document::*;
pub use format::{Format, NEWEST_FORMAT};
pub use layers::{
    AreaLayerReader, BrickLayerReader, GridLayerReader, LayerContext, LayerRead, LayerReader,
    Reference, RulerLayerReader, TextLayerReader,
};
pub use node::{FromNode, Node};
pub use reader::BlueBrickReader;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BlueBrickError {
    NotXml(String),
    NotMap(String),
    NewerVersion { version: u32 },
    Malformed { path: String, problem: String },
}

impl BlueBrickError {
    pub fn kind(&self) -> &'static str {
        match self {
            BlueBrickError::NotXml(_) => "notXml",
            BlueBrickError::NotMap(_) => "notMap",
            BlueBrickError::NewerVersion { .. } => "newerVersion",
            BlueBrickError::Malformed { .. } => "malformed",
        }
    }
}

impl std::fmt::Display for BlueBrickError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            BlueBrickError::NotXml(problem) => {
                write!(f, "not a BlueBrick map: the file isn't well-formed XML, because {problem}")
            }
            BlueBrickError::NotMap(problem) => {
                write!(f, "not a BlueBrick map: {problem}")
            }
            BlueBrickError::NewerVersion { version } => write!(
                f,
                "this map was saved by a newer BlueBrick (data version {version}); this reader knows versions up to {NEWEST_FORMAT}"
            ),
            BlueBrickError::Malformed { path, problem } => {
                write!(f, "the BlueBrick map is damaged: {path} {problem}")
            }
        }
    }
}

pub fn read_bbm(bytes: &[u8]) -> Result<BlueBrickMap, BlueBrickError> {
    BlueBrickReader::default().read(bytes)
}
