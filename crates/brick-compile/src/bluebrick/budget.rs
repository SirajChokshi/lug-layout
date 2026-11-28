use rustc_hash::FxHashSet;
use serde::Serialize;

use super::file::BlueBrickFile;
use super::node::Node;
use super::BlueBrickError;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BlueBrickBudget {
    pub version: u32,
    pub parts: Vec<BudgetedPart>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BudgetedPart {
    pub id: String,
    pub count: u32,
}

pub fn read_bbb(bytes: &[u8]) -> Result<BlueBrickBudget, BlueBrickError> {
    let file = BlueBrickFile::Budget;
    let root = file.parse(bytes)?;
    let budget = Node::root(&root);
    let version = file.version(&budget)?;
    let mut ids = FxHashSet::default();
    let parts = budget
        .required("PartList")?
        .each("Part")
        .map(|part| {
            let id = part
                .attribute("id")
                .ok_or_else(|| part.malformed("has no id attribute"))?;
            if !ids.insert(id) {
                return Err(part.malformed(format!("repeats the part id {id:?}")));
            }
            let count = u32::try_from(part.as_integer()?)
                .map_err(|_| part.malformed(format!("{:?} isn't a count", part.text())))?;
            Ok(BudgetedPart {
                id: id.to_string(),
                count,
            })
        })
        .collect::<Result<_, BlueBrickError>>()?;
    Ok(BlueBrickBudget { version, parts })
}
