use std::collections::BTreeMap;

use super::document::{
    AreaCell, AreaLayer, Brick, BrickLayer, CellIndex, Connection, ConnectionRef, DecimalText,
    DistanceUnit, GridLayer, Guideline, IndexLabels, ItemId, LayerContent, ReadIssue, Ruler,
    RulerEnd, RulerLayer, RulerShape, TextAlignment, TextCell, TextLayer,
};
use super::format::Format;
use super::groups::GroupTable;
use super::node::Node;
use super::values::stroke;
use super::BlueBrickError;

const RGB_MASK: u32 = 0x00ff_ffff;
const DISTANCE_UNITS: [DistanceUnit; 6] = [
    DistanceUnit::Stud,
    DistanceUnit::Ldu,
    DistanceUnit::StraightTrack,
    DistanceUnit::Module,
    DistanceUnit::Meter,
    DistanceUnit::Feet,
];

#[derive(Clone, Copy, Debug)]
pub struct LayerContext {
    pub index: usize,
    pub format: Format,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reference {
    Link {
        from: ConnectionRef,
        target: ItemId,
    },
    Attachment {
        layer: usize,
        ruler: usize,
        end: RulerEnd,
        target: ItemId,
    },
}

pub struct LayerRead {
    pub content: LayerContent,
    pub references: Vec<Reference>,
    pub issues: Vec<ReadIssue>,
}

pub trait LayerReader {
    fn layer_type(&self) -> &'static str;

    fn read(&self, layer: &Node<'_>, context: LayerContext) -> Result<LayerRead, BlueBrickError>;
}

pub struct GridLayerReader;

impl LayerReader for GridLayerReader {
    fn layer_type(&self) -> &'static str {
        "grid"
    }

    fn read(&self, layer: &Node<'_>, context: LayerContext) -> Result<LayerRead, BlueBrickError> {
        let format = context.format;
        let grid = GridLayer {
            lines: stroke(layer, "GridColor", "GridThickness", format)?,
            sub_lines: stroke(layer, "SubGridColor", "SubGridThickness", format)?,
            cell_size: layer.integer("GridSizeInStud")?,
            subdivisions: layer.integer("SubDivisionNumber")?,
            show_lines: layer
                .child("DisplayGrid")
                .map(|shown| shown.as_boolean())
                .transpose()?,
            show_sub_lines: layer.boolean("DisplaySubGrid")?,
            cell_index: CellIndex {
                shown: layer.boolean("DisplayCellIndex")?,
                font: layer.read("CellIndexFont", format)?,
                color: layer.read("CellIndexColor", format)?,
                columns: index_labels(&layer.required("CellIndexColumnType")?)?,
                rows: index_labels(&layer.required("CellIndexRowType")?)?,
                origin: layer.read("CellIndexCorner", format)?,
            },
        };
        Ok(LayerRead {
            content: LayerContent::Grid(grid),
            references: Vec::new(),
            issues: Vec::new(),
        })
    }
}

fn index_labels(node: &Node<'_>) -> Result<IndexLabels, BlueBrickError> {
    match node.as_integer()? {
        0 => Ok(IndexLabels::Letters),
        1 => Ok(IndexLabels::Numbers),
        other => Err(node.malformed(format!("{other} isn't a cell index type"))),
    }
}

pub struct BrickLayerReader;

impl LayerReader for BrickLayerReader {
    fn layer_type(&self) -> &'static str {
        "brick"
    }

    fn read(&self, layer: &Node<'_>, context: LayerContext) -> Result<LayerRead, BlueBrickError> {
        let format = context.format;
        let show_elevation = if format.has_elevation_display() {
            layer.boolean("DisplayBrickElevation")?
        } else {
            false
        };
        let mut groups = GroupTable::read(layer, context)?;
        let mut references = Vec::new();
        let mut bricks = Vec::new();
        for (index, brick) in layer.required("Bricks")?.each("Brick").enumerate() {
            let id = if format.has_brick_ids() {
                Some(brick.id_attribute()?)
            } else {
                None
            };
            let area = brick.read("DisplayArea", format)?;
            let group = groups.membership(&brick)?;
            let mut connections = Vec::new();
            for (position, connection) in
                brick.required("Connexions")?.each("Connexion").enumerate()
            {
                if let Some(target) = connection.reference("LinkedTo")? {
                    references.push(Reference::Link {
                        from: ConnectionRef {
                            layer: context.index,
                            brick: index,
                            connection: position,
                        },
                        target,
                    });
                }
                connections.push(Connection {
                    id: connection.id_attribute()?,
                    link: None,
                });
            }
            bricks.push(Brick {
                id,
                part: brick.string("PartNumber")?,
                area,
                orientation: brick.decimal("Orientation")?,
                altitude: if format.has_altitude() {
                    brick.decimal("Altitude")?
                } else {
                    DecimalText::zero()
                },
                active_connection: brick.integer("ActiveConnectionPointIndex")?,
                group,
                connections,
            });
        }
        let (groups, issues) = groups.finish();
        Ok(LayerRead {
            content: LayerContent::Brick(BrickLayer {
                show_elevation,
                bricks,
                groups,
            }),
            references,
            issues,
        })
    }
}

pub struct AreaLayerReader;

impl LayerReader for AreaLayerReader {
    fn layer_type(&self) -> &'static str {
        "area"
    }

    fn read(&self, layer: &Node<'_>, _: LayerContext) -> Result<LayerRead, BlueBrickError> {
        let mut cells = BTreeMap::new();
        for area in layer.required("Areas")?.each("Area") {
            let x = area.integer("x")?;
            let y = area.integer("y")?;
            cells.insert((x, y), area.required("color")?.as_hex()? & RGB_MASK);
        }
        Ok(LayerRead {
            content: LayerContent::Area(AreaLayer {
                cell_size: layer.integer("AreaCellSize")?,
                cells: cells
                    .into_iter()
                    .map(|((x, y), rgb)| AreaCell { x, y, rgb })
                    .collect(),
            }),
            references: Vec::new(),
            issues: Vec::new(),
        })
    }
}

pub struct TextLayerReader;

impl LayerReader for TextLayerReader {
    fn layer_type(&self) -> &'static str {
        "text"
    }

    fn read(&self, layer: &Node<'_>, context: LayerContext) -> Result<LayerRead, BlueBrickError> {
        let format = context.format;
        let mut groups = GroupTable::read(layer, context)?;
        let mut texts = Vec::new();
        for cell in layer.required("TextCells")?.each("TextCell") {
            texts.push(TextCell {
                area: cell.read("DisplayArea", format)?,
                group: groups.membership(&cell)?,
                text: cell.string("Text")?,
                orientation: cell.decimal("Orientation")?,
                color: cell.read("FontColor", format)?,
                font: cell.read("Font", format)?,
                alignment: match cell.required("TextAlignment")?.text() {
                    "Near" => TextAlignment::Near,
                    "Far" => TextAlignment::Far,
                    _ => TextAlignment::Center,
                },
            });
        }
        let (groups, issues) = groups.finish();
        Ok(LayerRead {
            content: LayerContent::Text(TextLayer { texts, groups }),
            references: Vec::new(),
            issues,
        })
    }
}

pub struct RulerLayerReader;

impl LayerReader for RulerLayerReader {
    fn layer_type(&self) -> &'static str {
        "ruler"
    }

    fn read(&self, layer: &Node<'_>, context: LayerContext) -> Result<LayerRead, BlueBrickError> {
        let mut groups = GroupTable::read(layer, context)?;
        let mut references = Vec::new();
        let mut rulers = Vec::new();
        for (index, ruler) in layer.required("RulerItems")?.elements().enumerate() {
            let mut attach = |end: RulerEnd, name: &str| -> Result<(), BlueBrickError> {
                if let Some(target) = ruler.reference(name)?.filter(|id| id.value() != 0) {
                    references.push(Reference::Attachment {
                        layer: context.index,
                        ruler: index,
                        end,
                        target,
                    });
                }
                Ok(())
            };
            let shape = match ruler.name() {
                "LinearRuler" => {
                    attach(RulerEnd::From, "AttachedBrick1")?;
                    attach(RulerEnd::To, "AttachedBrick2")?;
                    RulerShape::Linear {
                        from: ruler.read("Point1", context.format)?,
                        to: ruler.read("Point2", context.format)?,
                        from_attachment: None,
                        to_attachment: None,
                        offset: ruler.decimal("OffsetDistance")?,
                        allow_offset: ruler.boolean("AllowOffset")?,
                    }
                }
                "CircularRuler" => {
                    attach(RulerEnd::Center, "AttachedBrick")?;
                    RulerShape::Circular {
                        center: ruler.read("Center", context.format)?,
                        radius: ruler.decimal("Radius")?,
                        attachment: None,
                    }
                }
                other => return Err(ruler.malformed(format!("<{other}> isn't a ruler"))),
            };
            rulers.push(read_ruler(&ruler, &mut groups, context.format, shape)?);
        }
        let (groups, issues) = groups.finish();
        Ok(LayerRead {
            content: LayerContent::Ruler(RulerLayer { rulers, groups }),
            references,
            issues,
        })
    }
}

fn read_ruler(
    ruler: &Node<'_>,
    groups: &mut GroupTable,
    format: Format,
    shape: RulerShape,
) -> Result<Ruler, BlueBrickError> {
    let unit = ruler.required("Unit")?;
    let guideline_dash = ruler.required("GuidelineDashPattern")?;
    Ok(Ruler {
        area: ruler.read("DisplayArea", format)?,
        group: groups.membership(ruler)?,
        color: ruler.read("Color", format)?,
        line_thickness: ruler.number("LineThickness")?,
        show_distance: ruler.boolean("DisplayDistance")?,
        show_unit: ruler.boolean("DisplayUnit")?,
        guideline: Guideline {
            color: ruler.read("GuidelineColor", format)?,
            thickness: ruler.number("GuidelineThickness")?,
            dash_pattern: guideline_dash
                .each("value")
                .map(|value| value.as_number())
                .collect::<Result<_, _>>()?,
        },
        unit: usize::try_from(unit.as_integer()?)
            .ok()
            .and_then(|index| DISTANCE_UNITS.get(index).copied())
            .ok_or_else(|| unit.malformed(format!("{:?} isn't a distance unit", unit.text())))?,
        measure_font: ruler.read("MeasureFont", format)?,
        measure_color: ruler.read("MeasureFontColor", format)?,
        shape,
    })
}
