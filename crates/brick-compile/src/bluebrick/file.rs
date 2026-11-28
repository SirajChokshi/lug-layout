use super::element::Element;
use super::format::NEWEST_FORMAT;
use super::node::Node;
use super::BlueBrickError;

pub const NEWEST_BUDGET_FORMAT: u32 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BlueBrickFile {
    Map,
    Budget,
}

impl BlueBrickFile {
    pub fn noun(self) -> &'static str {
        match self {
            BlueBrickFile::Map => "map",
            BlueBrickFile::Budget => "budget",
        }
    }

    pub fn newest_version(self) -> u32 {
        match self {
            BlueBrickFile::Map => NEWEST_FORMAT,
            BlueBrickFile::Budget => NEWEST_BUDGET_FORMAT,
        }
    }

    fn root_element(self) -> &'static str {
        match self {
            BlueBrickFile::Map => "Map",
            BlueBrickFile::Budget => "Budget",
        }
    }

    pub(super) fn parse(self, bytes: &[u8]) -> Result<Element, BlueBrickError> {
        let root = Element::parse(bytes).map_err(|problem| BlueBrickError::NotXml {
            file: self,
            problem,
        })?;
        if root.name() != self.root_element() {
            return Err(self.unrecognized(format!(
                "its root element is <{}>, not <{}>",
                root.name(),
                self.root_element()
            )));
        }
        Ok(root)
    }

    pub(super) fn version(self, root: &Node<'_>) -> Result<u32, BlueBrickError> {
        let version = root.child("Version").ok_or_else(|| {
            self.unrecognized(format!("its <{}> has no <Version>", self.root_element()))
        })?;
        let number = u32::try_from(version.as_integer()?)
            .map_err(|_| version.malformed(format!("{:?} isn't a version", version.text())))?;
        if number > self.newest_version() {
            return Err(BlueBrickError::NewerVersion {
                file: self,
                version: number,
            });
        }
        Ok(number)
    }

    fn unrecognized(self, problem: String) -> BlueBrickError {
        BlueBrickError::Unrecognized {
            file: self,
            problem,
        }
    }
}
