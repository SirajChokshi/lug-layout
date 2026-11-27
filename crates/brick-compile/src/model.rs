use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::affine::Affine;
use crate::authored::{identify_authored, is_signed_permutation, Authored, Rational};
use crate::flatten::INHERIT_COLOR;
use crate::ldraw::{self, Header, Line, PrintedDecimal};

const MAX_SUBMODEL_DEPTH: usize = 32;
pub const MODEL_ROOT: i64 = -1;
const MODEL_ORG: &str = "model";
const UNOFFICIAL_PREFIX: &str = "unofficial_";
const PART_FILE_EXTENSION: &str = ".dat";
const SUBPART_DIRECTORY: &str = "s/";
const OMR_SET_SEPARATOR: &str = " - ";
const TRANSLATION_ENTRIES: [usize; 3] = [3, 7, 11];
const ROTATION_ENTRIES: [usize; 9] = [0, 1, 2, 4, 5, 6, 8, 9, 10];

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BakeOptions {
    pub omr_authoring_identification: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthoredLineKind {
    Instance,
    Placement,
}

impl AuthoredLineKind {
    pub fn name(self) -> &'static str {
        match self {
            AuthoredLineKind::Instance => "instance",
            AuthoredLineKind::Placement => "placement",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum AuthoredPrinted {
    Decimal(PrintedDecimal),
    Float(f64),
}

impl std::fmt::Display for AuthoredPrinted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match *self {
            AuthoredPrinted::Float(value) => write!(f, "{value:?}"),
            AuthoredPrinted::Decimal(PrintedDecimal { units, scale }) => {
                let digits = units.unsigned_abs().to_string();
                let scale = scale as usize;
                let sign = if units < 0 { "-" } else { "" };
                if scale == 0 {
                    return write!(f, "{sign}{digits}");
                }
                let padded = format!("{digits:0>width$}", width = scale + 1);
                let (whole, fraction) = padded.split_at(padded.len() - scale);
                write!(f, "{sign}{whole}.{fraction}")
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AuthoredRow {
    pub kind: AuthoredLineKind,
    pub line: usize,
    pub axis: u8,
    pub printed: AuthoredPrinted,
    pub outcome: Authored,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AuthoredIdentification {
    pub rows: Vec<AuthoredRow>,
    pub excluded_rotated: Vec<(AuthoredLineKind, usize)>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AuthoredColumns {
    pub line: Vec<usize>,
    pub line_kind: Vec<&'static str>,
    pub axis: Vec<u8>,
    pub printed: Vec<String>,
    pub grid: Vec<&'static str>,
    pub identified: Vec<Option<RationalText>>,
    pub residual: Vec<Option<RationalText>>,
    pub excluded_line: Vec<usize>,
    pub excluded_line_kind: Vec<&'static str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RationalText {
    pub numerator: String,
    pub denominator: String,
}

impl From<Rational> for RationalText {
    fn from(value: Rational) -> Self {
        RationalText {
            numerator: value.numerator.to_string(),
            denominator: value.denominator.to_string(),
        }
    }
}

const UNIDENTIFIED_GRID: &str = "unidentified";

impl AuthoredIdentification {
    pub fn columns(&self, drawn_instance: impl Fn(usize) -> Option<usize>) -> AuthoredColumns {
        let line_of = |kind: AuthoredLineKind, line: usize| match kind {
            AuthoredLineKind::Instance => drawn_instance(line),
            AuthoredLineKind::Placement => Some(line),
        };
        let mut columns = AuthoredColumns::default();
        for row in &self.rows {
            let Some(line) = line_of(row.kind, row.line) else {
                continue;
            };
            columns.line.push(line);
            columns.line_kind.push(row.kind.name());
            columns.axis.push(row.axis);
            columns.printed.push(row.printed.to_string());
            match row.outcome {
                Authored::Identified {
                    grid,
                    value,
                    residual,
                } => {
                    columns.grid.push(grid.name());
                    columns.identified.push(Some(value.into()));
                    columns.residual.push(Some(residual.into()));
                }
                Authored::SixteenthStep(_) | Authored::Unidentified => {
                    columns.grid.push(UNIDENTIFIED_GRID);
                    columns.identified.push(None);
                    columns.residual.push(None);
                }
            }
        }
        for &(kind, line) in &self.excluded_rotated {
            if let Some(line) = line_of(kind, line) {
                columns.excluded_line.push(line);
                columns.excluded_line_kind.push(kind.name());
            }
        }
        columns
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelInstance {
    pub part: String,
    pub inline: Option<String>,
    pub color: u32,
    pub matrix: Affine,
    pub submodel: Option<usize>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SubmodelInstance {
    pub parent: Option<usize>,
    pub matrix: Affine,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct WrittenTransforms {
    pub instances: Vec<String>,
    pub placements: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BakedModel {
    pub sections: Vec<Header>,
    pub instances: Vec<ModelInstance>,
    pub submodels: Vec<SubmodelInstance>,
    pub inline_parts: Vec<InlinePart>,
    pub loose_geometry: Vec<LooseGeometry>,
    pub authored_identification: Option<AuthoredIdentification>,
    pub written_transforms: WrittenTransforms,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LooseGeometry {
    pub section: String,
    pub triangles: usize,
    pub quads: usize,
    pub occurrences: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlinePart {
    pub inline: String,
    pub official: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ModelError {
    Empty,
    SubmodelCycle { name: String },
}

pub fn submodel_index(instance: Option<usize>) -> i64 {
    instance.map_or(MODEL_ROOT, |i| i as i64)
}

impl BakedModel {
    pub fn submodel_parents(&self) -> Vec<i64> {
        self.submodels
            .iter()
            .map(|s| submodel_index(s.parent))
            .collect()
    }

    pub fn submodel_matrices(&self) -> Vec<f64> {
        self.submodels.iter().flat_map(|s| s.matrix.m).collect()
    }
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ModelError::Empty => write!(f, "model has no content"),
            ModelError::SubmodelCycle { name } => write!(f, "submodel nesting too deep at {name}"),
        }
    }
}

struct Section {
    name: String,
    header: Header,
    lines: Vec<Line>,
}

impl Section {
    fn has_geometry(&self) -> bool {
        self.lines
            .iter()
            .any(|line| matches!(line, Line::Triangle { .. } | Line::Quad { .. }))
    }

    fn is_part(&self) -> bool {
        let declared = self
            .header
            .ldraw_org
            .as_deref()
            .and_then(|org| org.split_whitespace().next())
            .map(str::to_ascii_lowercase);
        match declared {
            Some(kind) => kind.trim_start_matches(UNOFFICIAL_PREFIX) != MODEL_ORG,
            None => self.name.ends_with(PART_FILE_EXTENSION) || self.has_geometry(),
        }
    }

    fn loose_geometry(&self) -> (usize, usize) {
        self.lines
            .iter()
            .fold((0, 0), |(triangles, quads), line| match line {
                Line::Triangle { .. } => (triangles + 1, quads),
                Line::Quad { .. } => (triangles, quads + 1),
                _ => (triangles, quads),
            })
    }
}

fn is_omr_set_number(prefix: &str) -> bool {
    let mut halves = prefix.splitn(2, '-');
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    halves.next().is_some_and(digits) && halves.next().is_none_or(digits)
}

pub fn official_reference(inline_name: &str) -> String {
    let (directory, name) = match inline_name.strip_prefix(SUBPART_DIRECTORY) {
        Some(rest) => (SUBPART_DIRECTORY, rest),
        None => ("", inline_name),
    };
    match name.split_once(OMR_SET_SEPARATOR) {
        Some((prefix, part)) if is_omr_set_number(prefix) => format!("{directory}{part}"),
        _ => inline_name.to_string(),
    }
}

fn file_meta_name(line: &str) -> Option<String> {
    let mut tokens = line.split_whitespace();
    if tokens.next() != Some("0") || !tokens.next()?.eq_ignore_ascii_case("FILE") {
        return None;
    }
    let name = tokens.collect::<Vec<_>>().join(" ");
    (!name.is_empty()).then(|| ldraw::normalize_reference(&name))
}

fn split_sections(source: &str) -> (Vec<String>, Vec<String>) {
    let mut names = Vec::new();
    let mut bodies: Vec<String> = Vec::new();
    for line in source.lines() {
        if let Some(name) = file_meta_name(line) {
            names.push(name);
            bodies.push(String::new());
            continue;
        }
        if bodies.is_empty() {
            names.push(String::new());
            bodies.push(String::new());
        }
        if let Some(body) = bodies.last_mut() {
            body.push_str(line);
            body.push('\n');
        }
    }
    (names, bodies)
}

pub fn mpd_sections(source: &str) -> HashMap<String, String> {
    let (names, bodies) = split_sections(source);
    names.into_iter().zip(bodies).collect()
}

pub fn bake_model(source: &str) -> Result<BakedModel, ModelError> {
    bake_model_with(source, BakeOptions::default())
}

pub fn bake_model_with(source: &str, options: BakeOptions) -> Result<BakedModel, ModelError> {
    let (names, bodies) = split_sections(source);
    if names.is_empty() {
        return Err(ModelError::Empty);
    }
    let sections: Vec<Section> = names
        .iter()
        .zip(&bodies)
        .map(|(name, body)| {
            let file = ldraw::parse(body);
            Section {
                name: name.clone(),
                header: file.header,
                lines: file.lines,
            }
        })
        .collect();
    let index: HashMap<&str, usize> = names
        .iter()
        .enumerate()
        .map(|(i, name)| (name.as_str(), i))
        .collect();
    let mut out = WalkOutput {
        authored: options
            .omr_authoring_identification
            .then(AuthoredIdentification::default),
        ..WalkOutput::default()
    };
    walk(
        &Walk {
            sections: &sections,
            index: &index,
            names: &names,
        },
        0,
        &Affine::IDENTITY,
        INHERIT_COLOR,
        None,
        0,
        &mut out,
    )?;
    let WalkOutput {
        mut instances,
        mut submodels,
        inline_parts,
        reached,
        loose,
        authored,
        written,
    } = out;
    for instance in &mut instances {
        instance.matrix = y_up(&instance.matrix);
    }
    for submodel in &mut submodels {
        submodel.matrix = y_up(&submodel.matrix);
    }
    Ok(BakedModel {
        sections: sections
            .iter()
            .enumerate()
            .filter(|(index, _)| reached.contains(index))
            .map(|(_, section)| section.header.clone())
            .collect(),
        instances,
        submodels,
        inline_parts: inline_parts
            .into_iter()
            .map(|(inline, official)| InlinePart { inline, official })
            .collect(),
        loose_geometry: loose
            .into_iter()
            .map(|(index, occurrences)| {
                let (triangles, quads) = sections[index].loose_geometry();
                LooseGeometry {
                    section: names[index].clone(),
                    triangles,
                    quads,
                    occurrences,
                }
            })
            .collect(),
        authored_identification: authored,
        written_transforms: written,
    })
}

fn y_up(matrix: &Affine) -> Affine {
    Affine {
        m: matrix.ldraw_to_y_up().m.map(|v| v + 0.0),
    }
}

#[derive(Default)]
struct WalkOutput {
    instances: Vec<ModelInstance>,
    submodels: Vec<SubmodelInstance>,
    inline_parts: BTreeMap<String, String>,
    reached: BTreeSet<usize>,
    loose: BTreeMap<usize, usize>,
    authored: Option<AuthoredIdentification>,
    written: WrittenTransforms,
}

impl WalkOutput {
    fn identified_line(
        &mut self,
        line_matrix: &Affine,
        printed: &[Option<PrintedDecimal>; 3],
        kind: AuthoredLineKind,
        line: usize,
    ) -> Affine {
        let Some(authored) = self.authored.as_mut() else {
            return *line_matrix;
        };
        if !is_signed_permutation(ROTATION_ENTRIES.map(|entry| line_matrix.m[entry])) {
            authored.excluded_rotated.push((kind, line));
            return *line_matrix;
        }
        let mut identified = *line_matrix;
        for (axis, (&entry, &decimal)) in TRANSLATION_ENTRIES.iter().zip(printed).enumerate() {
            let authored_value = line_matrix.m[entry];
            let outcome = identify_authored(decimal, authored_value);
            if let Some(value) = outcome.value() {
                identified.m[entry] = value.to_f64();
            }
            if !matches!(outcome, Authored::SixteenthStep(_)) {
                authored.rows.push(AuthoredRow {
                    kind,
                    line,
                    axis: axis as u8,
                    printed: decimal.map_or(
                        AuthoredPrinted::Float(authored_value),
                        AuthoredPrinted::Decimal,
                    ),
                    outcome,
                });
            }
        }
        identified
    }
}

struct Walk<'a> {
    sections: &'a [Section],
    index: &'a HashMap<&'a str, usize>,
    names: &'a [String],
}

fn walk(
    model: &Walk,
    section: usize,
    matrix: &Affine,
    color: u32,
    holder: Option<usize>,
    depth: usize,
    out: &mut WalkOutput,
) -> Result<(), ModelError> {
    let Some(current) = model.sections.get(section) else {
        return Ok(());
    };
    out.reached.insert(section);
    if current.has_geometry() {
        *out.loose.entry(section).or_default() += 1;
    }
    if depth > MAX_SUBMODEL_DEPTH {
        return Err(ModelError::SubmodelCycle {
            name: current.header.name.clone(),
        });
    }
    for line in &current.lines {
        let Line::Subfile {
            color: line_color,
            matrix: line_matrix,
            printed_translation,
            written,
            reference,
        } = line
        else {
            continue;
        };
        let child_color = if *line_color == INHERIT_COLOR {
            color
        } else {
            *line_color
        };
        let placement = model
            .index
            .get(reference.as_str())
            .is_some_and(|&child| !model.sections[child].is_part());
        let (kind, line_index) = if placement {
            (AuthoredLineKind::Placement, out.submodels.len())
        } else {
            (AuthoredLineKind::Instance, out.instances.len())
        };
        let line_matrix = out.identified_line(line_matrix, printed_translation, kind, line_index);
        let child_matrix = matrix.then(&line_matrix);
        match model.index.get(reference.as_str()) {
            Some(&child) if model.sections[child].is_part() => {
                let official = official_reference(&model.names[child]);
                out.inline_parts
                    .insert(model.names[child].clone(), official.clone());
                out.written.instances.push(written.clone());
                out.instances.push(ModelInstance {
                    part: official,
                    inline: Some(model.names[child].clone()),
                    color: child_color,
                    matrix: child_matrix,
                    submodel: holder,
                });
            }
            Some(&child) => {
                out.written.placements.push(written.clone());
                out.submodels.push(SubmodelInstance {
                    parent: holder,
                    matrix: child_matrix,
                });
                let instance = Some(out.submodels.len() - 1);
                walk(
                    model,
                    child,
                    &child_matrix,
                    child_color,
                    instance,
                    depth + 1,
                    out,
                )?;
            }
            None => {
                out.written.instances.push(written.clone());
                out.instances.push(ModelInstance {
                    part: reference.clone(),
                    inline: None,
                    color: child_color,
                    matrix: child_matrix,
                    submodel: holder,
                });
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const CRITIC_GAP_PROBE: &str = "0 FILE critic-gap.ldr
0 Critic gap probe
0 Name: critic-gap.ldr
0 Author: critic
0 !LDRAW_ORG Model
1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat
1 2 120 0 0 1 0 0 0 1 0 0 0 1 mycustom.dat
1 14 240 0 0 1 0 0 0 1 0 0 0 1 mycustom2.dat
1 1 0 0 120 1 0 0 0 1 0 0 0 1 9999-1 - 3001.dat
4 2 -40 -40 60 40 -40 60 40 -40 120 -40 -40 120
0 NOFILE
0 FILE mycustom.dat
0 My custom part without LDRAW_ORG header
0 Name: mycustom.dat
1 16 0 0 0 10 0 0 0 1 0 0 0 10 4-4cyli.dat
3 16 0 -24 0 30 -60 0 -30 -60 0
0 NOFILE
0 FILE mycustom2.dat
0 My custom part with header
0 Name: mycustom2.dat
0 !LDRAW_ORG Unofficial_Part
1 16 0 0 0 10 0 0 0 1 0 0 0 10 4-4cyli.dat
3 16 0 -24 0 30 -60 0 -30 -60 0
0 NOFILE
0 FILE 9999-1 - 3001.dat
0 Recoloured copy
0 Name: 9999-1 - 3001.dat
0 !LDRAW_ORG Unofficial_Part
1 4 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat
4 14 -30 0 -10 -30 16 -10 30 16 -10 30 0 -10
0 NOFILE
";

    fn baked_probe() -> BakedModel {
        bake_model(CRITIC_GAP_PROBE).unwrap_or_else(|e| panic!("probe bakes: {e}"))
    }

    #[test]
    fn a_headerless_dat_section_is_an_inline_part_and_its_primitives_never_leak_as_parts() {
        let baked = baked_probe();
        let parts: Vec<(&str, Option<&str>)> = baked
            .instances
            .iter()
            .map(|i| (i.part.as_str(), i.inline.as_deref()))
            .collect();
        assert_eq!(
            parts,
            vec![
                ("3001.dat", None),
                ("mycustom.dat", Some("mycustom.dat")),
                ("mycustom2.dat", Some("mycustom2.dat")),
                ("3001.dat", Some("9999-1 - 3001.dat")),
            ]
        );
    }

    #[test]
    fn geometry_outside_parts_is_reported_per_model_section() {
        assert_eq!(
            baked_probe().loose_geometry,
            vec![LooseGeometry {
                section: "critic-gap.ldr".into(),
                triangles: 0,
                quads: 1,
                occurrences: 1,
            }]
        );
    }

    const OMR: BakeOptions = BakeOptions {
        omr_authoring_identification: true,
    };

    fn part_line(x: &str, rotation: &str) -> String {
        format!("1 16 {x} 0 0 {rotation} 3001.dat\n")
    }

    fn rational(numerator: i128, denominator: i128) -> Option<RationalText> {
        Some(RationalText {
            numerator: numerator.to_string(),
            denominator: denominator.to_string(),
        })
    }

    type Provenance = Option<(&'static str, Option<RationalText>, Option<RationalText>)>;

    #[test]
    fn omr_identification_takes_whole_ldu_within_r1_and_finer_grids_only_within_the_print_bound() {
        let identity = "1 0 0 0 1 0 0 0 1";
        let cases: [(&str, f64, Provenance); 12] = [
            (
                "10.02",
                10.0,
                Some(("whole", rational(10, 1), rational(-1, 50))),
            ),
            (
                "-7.05",
                -7.0,
                Some(("whole", rational(-7, 1), rational(1, 20))),
            ),
            (
                "10.06",
                10.0625,
                Some(("sixteenth", rational(161, 16), rational(1, 400))),
            ),
            (
                "3.13",
                3.125,
                Some(("eighth", rational(25, 8), rational(-1, 200))),
            ),
            ("0.185", 0.185, Some(("unidentified", None, None))),
            ("4.1", 4.1, Some(("unidentified", None, None))),
            ("20.063", 20.0625, None),
            ("5.5", 5.5, None),
            (
                "3.125e-2",
                0.0,
                Some(("whole", rational(0, 1), rational(-1, 32))),
            ),
            ("6.3e-2", 0.0625, None),
            ("1.3e-1", 0.13, Some(("unidentified", None, None))),
            ("5.8e-2", 0.058, Some(("unidentified", None, None))),
        ];
        let source: String = std::iter::once("0 FILE main.ldr\n0 !LDRAW_ORG Model\n".to_string())
            .chain(cases.iter().map(|(x, _, _)| part_line(x, identity)))
            .collect();
        let baked = bake_model_with(&source, OMR).unwrap_or_else(|e| panic!("bakes: {e}"));
        let columns = baked
            .authored_identification
            .as_ref()
            .unwrap_or_else(|| panic!("the option records provenance"))
            .columns(Some);
        let mut row = 0;
        for (line, (printed, value, provenance)) in cases.iter().enumerate() {
            assert_eq!(baked.instances[line].matrix.m[3], *value, "{printed}");
            let Some((grid, identified, residual)) = provenance else {
                continue;
            };
            assert_eq!(
                (
                    columns.line[row],
                    columns.line_kind[row],
                    columns.axis[row],
                    columns.grid[row],
                    &columns.identified[row],
                    &columns.residual[row],
                ),
                (line, "instance", 0, *grid, identified, residual),
                "{printed}"
            );
            row += 1;
        }
        assert_eq!(columns.line.len(), row);
        assert!(columns.excluded_line.is_empty());
    }

    #[test]
    fn omr_identification_leaves_turned_lines_as_authored_and_identifies_placements_in_their_parent_frame(
    ) {
        let source = "0 FILE main.ldr\n0 !LDRAW_ORG Model\n1 16 40.02 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n1 16 10.02 0 0 0.866025 0 0.5 0 1 0 -0.5 0 0.866025 3001.dat\n0 FILE sub.ldr\n0 !LDRAW_ORG Model\n1 4 0.01 0 20 1 0 0 0 1 0 0 0 1 3003.dat\n";
        let baked = bake_model_with(source, OMR).unwrap_or_else(|e| panic!("bakes: {e}"));
        let columns = baked
            .authored_identification
            .as_ref()
            .unwrap_or_else(|| panic!("the option records provenance"))
            .columns(Some);
        assert_eq!(baked.submodels[0].matrix.m[3], 40.0);
        assert_eq!(baked.instances[0].matrix.m[3], 40.0);
        assert_eq!(baked.instances[1].matrix.m[3], 10.02);
        assert_eq!(
            (columns.line, columns.line_kind, columns.printed),
            (
                vec![0, 0],
                vec!["placement", "instance"],
                vec!["40.02".to_string(), "0.01".to_string()]
            )
        );
        assert_eq!(
            (columns.excluded_line, columns.excluded_line_kind),
            (vec![1], vec!["instance"])
        );
    }

    #[test]
    fn written_transforms_keep_every_type_1_line_as_written_in_instance_and_placement_order() {
        let source = "0 FILE main.ldr\n0 !LDRAW_ORG Model\n\
            1 16 40.02 -8 0 0.6 0 0.8 0 1 0 -0.8 0 0.6 sub.ldr\n\
            1 16 10.02 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n\
            0 FILE sub.ldr\n\
            1 16 .5 +5. 1e-3 1 0 0 0 1 0 0 0 1 3001.dat\n";
        let expected = WrittenTransforms {
            instances: vec![
                ".5 +5. 1e-3 1 0 0 0 1 0 0 0 1".to_string(),
                "10.02 0 0 1 0 0 0 1 0 0 0 1".to_string(),
            ],
            placements: vec!["40.02 -8 0 0.6 0 0.8 0 1 0 -0.8 0 0.6".to_string()],
        };
        let plain = bake_model(source).unwrap_or_else(|e| panic!("bakes: {e}"));
        let identified = bake_model_with(source, OMR).unwrap_or_else(|e| panic!("bakes: {e}"));
        assert_eq!(identified.instances[1].matrix.m[3], 10.0);
        assert_eq!(plain.written_transforms, expected);
        assert_eq!(identified.written_transforms, expected);
    }

    #[test]
    fn without_the_option_the_bake_keeps_authored_positions_and_records_no_provenance() {
        let source = format!(
            "0 FILE main.ldr\n0 !LDRAW_ORG Model\n{}",
            part_line("10.02", "1 0 0 0 1 0 0 0 1")
        );
        let baked = bake_model(&source).unwrap_or_else(|e| panic!("bakes: {e}"));
        assert_eq!(baked.instances[0].matrix.m[3], 10.02);
        assert!(baked.authored_identification.is_none());
    }

    #[test]
    fn headerless_ldr_submodels_and_unofficial_models_are_walked_as_models() {
        let source = "0 FILE main.ldr\n0 !LDRAW_ORG Model\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 sub.ldr\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 draft.ldr\n0 FILE sub.ldr\n1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat\n0 FILE draft.ldr\n0 !LDRAW_ORG Unofficial_Model\n1 1 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat\n";
        let baked = bake_model(source).unwrap_or_else(|e| panic!("bakes: {e}"));
        let parts: Vec<&str> = baked.instances.iter().map(|i| i.part.as_str()).collect();
        assert_eq!(parts, vec!["3001.dat", "3003.dat"]);
        assert!(baked.inline_parts.is_empty());
        assert!(baked.loose_geometry.is_empty());
    }
}
