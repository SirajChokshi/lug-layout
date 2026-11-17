use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::affine::Affine;
use crate::flatten::INHERIT_COLOR;
use crate::ldraw::{self, Header, Line};

const MAX_SUBMODEL_DEPTH: usize = 32;
const MODEL_ORG: &str = "model";
const UNOFFICIAL_PREFIX: &str = "unofficial_";
const PART_FILE_EXTENSION: &str = ".dat";
const SUBPART_DIRECTORY: &str = "s/";
const OMR_SET_SEPARATOR: &str = " - ";

#[derive(Clone, Debug, PartialEq)]
pub struct ModelInstance {
    pub part: String,
    pub inline: Option<String>,
    pub color: u32,
    pub matrix: Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BakedModel {
    pub sections: Vec<Header>,
    pub instances: Vec<ModelInstance>,
    pub inline_parts: Vec<InlinePart>,
    pub loose_geometry: Vec<LooseGeometry>,
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
    let mut out = WalkOutput::default();
    walk(
        &Walk {
            sections: &sections,
            index: &index,
            names: &names,
        },
        0,
        &Affine::IDENTITY,
        INHERIT_COLOR,
        0,
        &mut out,
    )?;
    let WalkOutput {
        mut instances,
        inline_parts,
        reached,
        loose,
    } = out;
    for instance in &mut instances {
        instance.matrix = Affine {
            m: instance.matrix.ldraw_to_y_up().m.map(|v| v + 0.0),
        };
    }
    Ok(BakedModel {
        sections: sections
            .iter()
            .enumerate()
            .filter(|(index, _)| reached.contains(index))
            .map(|(_, section)| section.header.clone())
            .collect(),
        instances,
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
    })
}

#[derive(Default)]
struct WalkOutput {
    instances: Vec<ModelInstance>,
    inline_parts: BTreeMap<String, String>,
    reached: BTreeSet<usize>,
    loose: BTreeMap<usize, usize>,
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
        let child_matrix = matrix.then(line_matrix);
        match model.index.get(reference.as_str()) {
            Some(&child) if model.sections[child].is_part() => {
                let official = official_reference(&model.names[child]);
                out.inline_parts
                    .insert(model.names[child].clone(), official.clone());
                out.instances.push(ModelInstance {
                    part: official,
                    inline: Some(model.names[child].clone()),
                    color: child_color,
                    matrix: child_matrix,
                });
            }
            Some(&child) => walk(model, child, &child_matrix, child_color, depth + 1, out)?,
            None => out.instances.push(ModelInstance {
                part: reference.clone(),
                inline: None,
                color: child_color,
                matrix: child_matrix,
            }),
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
