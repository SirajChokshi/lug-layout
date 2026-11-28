use serde::{Serialize, Serializer};

use crate::exact::Decimal;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct DecimalText(String);

impl DecimalText {
    pub fn parse(text: &str) -> Option<DecimalText> {
        Decimal::parse(text.trim()).map(|decimal| DecimalText(decimal.exact().canonical()))
    }

    pub fn zero() -> DecimalText {
        DecimalText("0".to_string())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ItemId(u64);

impl ItemId {
    pub fn new(value: u64) -> ItemId {
        ItemId(value)
    }

    pub fn value(self) -> u64 {
        self.0
    }
}

impl Serialize for ItemId {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(&self.0)
    }
}

impl std::fmt::Display for ItemId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlueBrickMap {
    pub version: u32,
    pub properties: MapProperties,
    pub layers: Vec<Layer>,
    pub issues: Vec<ReadIssue>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapProperties {
    pub author: String,
    pub lug: String,
    pub event: String,
    pub date: MapDate,
    pub comment: String,
    pub background: Option<Color>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct MapDate {
    pub year: i32,
    pub month: i32,
    pub day: i32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Color {
    Named { name: String },
    Argb { argb: u32 },
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Font {
    pub family: String,
    pub size: f64,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikeout: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Rect {
    pub x: DecimalText,
    pub y: DecimalText,
    pub width: DecimalText,
    pub height: DecimalText,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Point {
    pub x: DecimalText,
    pub y: DecimalText,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct CellPoint {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: Option<ItemId>,
    pub name: String,
    pub visible: bool,
    pub opacity: i32,
    pub hull: Option<Hull>,
    #[serde(flatten)]
    pub content: LayerContent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hull {
    pub visible: bool,
    pub color: Color,
    pub thickness: i32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum LayerContent {
    Grid(GridLayer),
    Brick(BrickLayer),
    Area(AreaLayer),
    Text(TextLayer),
    Ruler(RulerLayer),
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GridLayer {
    pub lines: Stroke,
    pub sub_lines: Stroke,
    pub cell_size: i32,
    pub subdivisions: i32,
    pub show_lines: Option<bool>,
    pub show_sub_lines: bool,
    pub cell_index: CellIndex,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Stroke {
    pub color: Color,
    pub thickness: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellIndex {
    pub shown: bool,
    pub font: Font,
    pub color: Color,
    pub columns: IndexLabels,
    pub rows: IndexLabels,
    pub origin: CellPoint,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IndexLabels {
    Letters,
    Numbers,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrickLayer {
    pub show_elevation: bool,
    pub bricks: Vec<Brick>,
    pub groups: Vec<Group>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Brick {
    pub id: Option<ItemId>,
    pub part: String,
    pub area: Rect,
    pub orientation: DecimalText,
    pub altitude: DecimalText,
    pub active_connection: i32,
    pub group: Option<usize>,
    pub connections: Vec<Connection>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Connection {
    pub id: ItemId,
    pub link: Option<ConnectionRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub struct ConnectionRef {
    pub layer: usize,
    pub brick: usize,
    pub connection: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
pub struct BrickRef {
    pub layer: usize,
    pub brick: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Group {
    pub id: ItemId,
    pub part: Option<String>,
    pub parent: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AreaLayer {
    pub cell_size: i32,
    pub cells: Vec<AreaCell>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct AreaCell {
    pub x: i32,
    pub y: i32,
    pub rgb: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextLayer {
    pub texts: Vec<TextCell>,
    pub groups: Vec<Group>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct TextCell {
    pub area: Rect,
    pub group: Option<usize>,
    pub text: String,
    pub orientation: DecimalText,
    pub color: Color,
    pub font: Font,
    pub alignment: TextAlignment,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum TextAlignment {
    Near,
    Center,
    Far,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RulerLayer {
    pub rulers: Vec<Ruler>,
    pub groups: Vec<Group>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Ruler {
    pub area: Rect,
    pub group: Option<usize>,
    pub color: Color,
    pub line_thickness: f64,
    pub show_distance: bool,
    pub show_unit: bool,
    pub guideline: Guideline,
    pub unit: DistanceUnit,
    pub measure_font: Font,
    pub measure_color: Color,
    #[serde(flatten)]
    pub shape: RulerShape,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Guideline {
    pub color: Color,
    pub thickness: f64,
    pub dash_pattern: Vec<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DistanceUnit {
    Stud,
    Ldu,
    StraightTrack,
    Module,
    Meter,
    Feet,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "shape",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RulerShape {
    Linear {
        from: Point,
        to: Point,
        from_attachment: Option<BrickRef>,
        to_attachment: Option<BrickRef>,
        offset: DecimalText,
        allow_offset: bool,
    },
    Circular {
        center: Point,
        radius: DecimalText,
        attachment: Option<BrickRef>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RulerEnd {
    From,
    To,
    Center,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum IdHolder {
    Connection,
    Brick,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReadIssue {
    SkippedLayer {
        position: usize,
        layer_type: String,
    },
    DuplicateId {
        id: ItemId,
        holder: IdHolder,
    },
    DuplicateGroup {
        layer: usize,
        id: ItemId,
    },
    GroupCycle {
        layer: usize,
        group: usize,
    },
    DanglingLink {
        from: ConnectionRef,
        target: ItemId,
    },
    UnreciprocatedLink {
        from: ConnectionRef,
        to: ConnectionRef,
    },
    DanglingAttachment {
        layer: usize,
        ruler: usize,
        end: RulerEnd,
        target: ItemId,
    },
}
