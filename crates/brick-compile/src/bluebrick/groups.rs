use rustc_hash::FxHashMap;

use super::document::{Group, ItemId, ReadIssue};
use super::layers::LayerContext;
use super::node::Node;
use super::BlueBrickError;

struct Entry {
    id: ItemId,
    part: Option<String>,
    parent: Option<ItemId>,
}

pub struct GroupTable {
    context: LayerContext,
    entries: Vec<Entry>,
    index: FxHashMap<ItemId, usize>,
    issues: Vec<ReadIssue>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Walk {
    Unvisited,
    OnPath,
    Settled,
}

impl GroupTable {
    pub fn read(layer: &Node<'_>, context: LayerContext) -> Result<GroupTable, BlueBrickError> {
        let mut table = GroupTable {
            context,
            entries: Vec::new(),
            index: FxHashMap::default(),
            issues: Vec::new(),
        };
        if !context.format.has_groups() {
            return Ok(table);
        }
        for group in layer.required("Groups")?.each("Group") {
            let id = group.id_attribute()?;
            let part = group.string("PartNumber")?;
            let parent = group.reference("MyGroup")?;
            if table.index.contains_key(&id) {
                table.issues.push(ReadIssue::DuplicateGroup {
                    layer: context.index,
                    id,
                });
                continue;
            }
            table.index.insert(id, table.entries.len());
            table.entries.push(Entry {
                id,
                part: (!part.is_empty()).then_some(part),
                parent,
            });
        }
        Ok(table)
    }

    pub fn membership(&mut self, item: &Node<'_>) -> Result<Option<usize>, BlueBrickError> {
        if !self.context.format.has_groups() {
            return Ok(None);
        }
        Ok(item.reference("MyGroup")?.map(|id| self.entry(id)))
    }

    fn entry(&mut self, id: ItemId) -> usize {
        if let Some(&position) = self.index.get(&id) {
            return position;
        }
        let position = self.entries.len();
        self.index.insert(id, position);
        self.entries.push(Entry {
            id,
            part: None,
            parent: None,
        });
        position
    }

    pub fn finish(mut self) -> (Vec<Group>, Vec<ReadIssue>) {
        let mut parents = Vec::with_capacity(self.entries.len());
        let mut position = 0;
        while position < self.entries.len() {
            let parent = self.entries[position].parent.map(|id| self.entry(id));
            parents.push(parent);
            position += 1;
        }
        self.break_cycles(&mut parents);
        let groups = self
            .entries
            .into_iter()
            .zip(parents)
            .map(|(entry, parent)| Group {
                id: entry.id,
                part: entry.part,
                parent,
            })
            .collect();
        (groups, self.issues)
    }

    fn break_cycles(&mut self, parents: &mut [Option<usize>]) {
        let mut walk = vec![Walk::Unvisited; parents.len()];
        for start in 0..parents.len() {
            let mut path = Vec::new();
            let mut current = Some(start);
            while let Some(group) = current {
                match walk[group] {
                    Walk::Settled => break,
                    Walk::OnPath => {
                        if let Some(&closing) = path.last() {
                            parents[closing] = None;
                            self.issues.push(ReadIssue::GroupCycle {
                                layer: self.context.index,
                                group: closing,
                            });
                        }
                        break;
                    }
                    Walk::Unvisited => {
                        walk[group] = Walk::OnPath;
                        path.push(group);
                        current = parents[group];
                    }
                }
            }
            for group in path {
                walk[group] = Walk::Settled;
            }
        }
    }
}
