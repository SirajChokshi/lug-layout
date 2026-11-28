use rustc_hash::FxHashMap;

use super::document::{
    BrickRef, ConnectionRef, IdHolder, ItemId, Layer, LayerContent, ReadIssue, RulerEnd, RulerShape,
};
use super::layers::Reference;

enum Holder<T> {
    Unique(T),
    Repeated,
}

enum BackLink {
    Reciprocated,
    Ambiguous,
    Missing,
}

pub struct ReferenceResolver {
    connections: FxHashMap<ItemId, Holder<ConnectionRef>>,
    bricks: FxHashMap<ItemId, Holder<BrickRef>>,
    targets: FxHashMap<ConnectionRef, ItemId>,
    issues: Vec<ReadIssue>,
}

impl ReferenceResolver {
    pub fn new(layers: &[Layer], references: &[Reference]) -> ReferenceResolver {
        let mut resolver = ReferenceResolver {
            connections: FxHashMap::default(),
            bricks: FxHashMap::default(),
            targets: FxHashMap::default(),
            issues: Vec::new(),
        };
        for (layer, content) in layers.iter().enumerate() {
            let LayerContent::Brick(bricks) = &content.content else {
                continue;
            };
            for (brick, held) in bricks.bricks.iter().enumerate() {
                if let Some(id) = held.id {
                    resolver.hold_brick(id, BrickRef { layer, brick });
                }
                for (connection, held) in held.connections.iter().enumerate() {
                    resolver.hold_connection(
                        held.id,
                        ConnectionRef {
                            layer,
                            brick,
                            connection,
                        },
                    );
                }
            }
        }
        for reference in references {
            if let Reference::Link { from, target } = reference {
                resolver.targets.insert(*from, *target);
            }
        }
        resolver
    }

    fn hold_brick(&mut self, id: ItemId, at: BrickRef) {
        hold(&mut self.bricks, &mut self.issues, id, at, IdHolder::Brick);
    }

    fn hold_connection(&mut self, id: ItemId, at: ConnectionRef) {
        hold(
            &mut self.connections,
            &mut self.issues,
            id,
            at,
            IdHolder::Connection,
        );
    }

    fn connection(&self, id: ItemId) -> Option<&Holder<ConnectionRef>> {
        self.connections.get(&id)
    }

    fn back_link(&self, to: ConnectionRef, from: ConnectionRef) -> BackLink {
        if to == from {
            return BackLink::Missing;
        }
        match self
            .targets
            .get(&to)
            .and_then(|target| self.connection(*target))
        {
            Some(Holder::Unique(back)) if *back == from => BackLink::Reciprocated,
            Some(Holder::Repeated) => BackLink::Ambiguous,
            _ => BackLink::Missing,
        }
    }

    pub fn resolve(mut self, layers: &mut [Layer], references: &[Reference]) -> Vec<ReadIssue> {
        for reference in references {
            match *reference {
                Reference::Link { from, target } => self.link(layers, from, target),
                Reference::Attachment {
                    layer,
                    ruler,
                    end,
                    target,
                } => self.attach(layers, layer, ruler, end, target),
            }
        }
        self.issues
    }

    fn link(&mut self, layers: &mut [Layer], from: ConnectionRef, target: ItemId) {
        let to = match self.connection(target) {
            None => {
                self.issues.push(ReadIssue::DanglingLink { from, target });
                return;
            }
            Some(Holder::Repeated) => return,
            Some(Holder::Unique(to)) => *to,
        };
        match self.back_link(to, from) {
            BackLink::Missing => self.issues.push(ReadIssue::UnreciprocatedLink { from, to }),
            BackLink::Ambiguous => {}
            BackLink::Reciprocated => {
                if let LayerContent::Brick(bricks) = &mut layers[from.layer].content {
                    bricks.bricks[from.brick].connections[from.connection].link = Some(to);
                }
            }
        }
    }

    fn attach(
        &mut self,
        layers: &mut [Layer],
        layer: usize,
        ruler: usize,
        end: RulerEnd,
        target: ItemId,
    ) {
        let brick = match self.bricks.get(&target) {
            None => {
                self.issues.push(ReadIssue::DanglingAttachment {
                    layer,
                    ruler,
                    end,
                    target,
                });
                return;
            }
            Some(Holder::Repeated) => return,
            Some(Holder::Unique(brick)) => *brick,
        };
        let LayerContent::Ruler(rulers) = &mut layers[layer].content else {
            return;
        };
        let attachment = match (&mut rulers.rulers[ruler].shape, end) {
            (
                RulerShape::Linear {
                    from_attachment, ..
                },
                RulerEnd::From,
            ) => from_attachment,
            (RulerShape::Linear { to_attachment, .. }, RulerEnd::To) => to_attachment,
            (RulerShape::Circular { attachment, .. }, RulerEnd::Center) => attachment,
            _ => return,
        };
        *attachment = Some(brick);
    }
}

fn hold<T>(
    held: &mut FxHashMap<ItemId, Holder<T>>,
    issues: &mut Vec<ReadIssue>,
    id: ItemId,
    at: T,
    holder: IdHolder,
) {
    match held.get_mut(&id) {
        None => {
            held.insert(id, Holder::Unique(at));
        }
        Some(slot @ Holder::Unique(_)) => {
            *slot = Holder::Repeated;
            issues.push(ReadIssue::DuplicateId { id, holder });
        }
        Some(Holder::Repeated) => {}
    }
}
