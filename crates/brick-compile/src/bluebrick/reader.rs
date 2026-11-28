use super::document::{BlueBrickMap, Color, Layer, MapProperties, ReadIssue};
use super::file::BlueBrickFile;
use super::format::Format;
use super::layers::{
    AreaLayerReader, BrickLayerReader, GridLayerReader, LayerContext, LayerReader,
    RulerLayerReader, TextLayerReader,
};
use super::node::{FromNode, Node};
use super::references::ReferenceResolver;
use super::BlueBrickError;

const EVENT_ELEMENTS: [&str; 2] = ["Event", "Show"];
const OPAQUE_PERCENT: i32 = 100;

pub struct BlueBrickReader {
    layer_readers: Vec<Box<dyn LayerReader>>,
}

impl Default for BlueBrickReader {
    fn default() -> Self {
        BlueBrickReader::new(vec![
            Box::new(GridLayerReader),
            Box::new(BrickLayerReader),
            Box::new(AreaLayerReader),
            Box::new(TextLayerReader),
            Box::new(RulerLayerReader),
        ])
    }
}

impl BlueBrickReader {
    pub fn new(layer_readers: Vec<Box<dyn LayerReader>>) -> BlueBrickReader {
        BlueBrickReader { layer_readers }
    }

    pub fn read(&self, bytes: &[u8]) -> Result<BlueBrickMap, BlueBrickError> {
        let root = BlueBrickFile::Map.parse(bytes)?;
        let map = Node::root(&root);
        let version = BlueBrickFile::Map.version(&map)?;
        let format = Format::new(version);
        let properties = read_properties(&map, format)?;
        let mut layers = Vec::new();
        let mut references = Vec::new();
        let mut issues = Vec::new();
        for (position, layer) in map.required("Layers")?.each("Layer").enumerate() {
            let layer_type = layer
                .attribute("type")
                .ok_or_else(|| layer.malformed("has no type attribute"))?;
            let Some(reader) = self
                .layer_readers
                .iter()
                .find(|reader| reader.layer_type() == layer_type)
            else {
                issues.push(ReadIssue::SkippedLayer {
                    position,
                    layer_type: layer_type.to_string(),
                });
                continue;
            };
            let id = if format.has_layer_ids() {
                Some(layer.id_attribute()?)
            } else {
                None
            };
            let name = layer.string("Name")?;
            let visible = layer.boolean("Visible")?;
            let opacity = read_opacity(&layer, format)?;
            let hull = if format.has_hulls() {
                Some(layer.read("HullProperties", format)?)
            } else {
                None
            };
            let context = LayerContext {
                index: layers.len(),
                format,
            };
            let read = reader.read(&layer, context)?;
            layers.push(Layer {
                id,
                name,
                visible,
                opacity,
                hull,
                content: read.content,
            });
            references.extend(read.references);
            issues.extend(read.issues);
        }
        let resolver = ReferenceResolver::new(&layers, &references);
        issues.extend(resolver.resolve(&mut layers, &references));
        Ok(BlueBrickMap {
            version,
            properties,
            layers,
            issues,
        })
    }
}

fn read_properties(map: &Node<'_>, format: Format) -> Result<MapProperties, BlueBrickError> {
    Ok(MapProperties {
        author: map.string("Author")?,
        lug: map.string("LUG")?,
        event: map.required_any(&EVENT_ELEMENTS)?.text().to_string(),
        date: map.read("Date", format)?,
        comment: if format.has_comment() {
            map.string("Comment")?
        } else {
            String::new()
        },
        background: map
            .child("BackgroundColor")
            .map(|color| Color::from_node(&color, format))
            .transpose()?,
    })
}

fn read_opacity(layer: &Node<'_>, format: Format) -> Result<i32, BlueBrickError> {
    let Some(transparency) = layer.child("Transparency") else {
        return if format.has_layer_opacity() {
            Err(layer.malformed("has no <Transparency>"))
        } else {
            Ok(OPAQUE_PERCENT)
        };
    };
    let percent = transparency.as_integer()?;
    (0..=OPAQUE_PERCENT)
        .contains(&percent)
        .then_some(percent)
        .ok_or_else(|| transparency.malformed(format!("{percent} isn't a percentage")))
}
