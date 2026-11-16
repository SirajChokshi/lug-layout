use std::collections::{BTreeMap, BTreeSet, HashMap};

use crate::affine::Affine;
use crate::flatten::INHERIT_COLOR;
use crate::ldraw::{self, Header, Line};

const MAX_SUBMODEL_DEPTH: usize = 32;
const MODEL_ORG: &str = "model";
const SUBPART_DIRECTORY: &str = "s/";
const OMR_SET_SEPARATOR: &str = " - ";

#[derive(Clone, Debug, PartialEq)]
pub struct ModelInstance {
    pub part: String,
    pub color: u32,
    pub matrix: Affine,
}

#[derive(Clone, Debug, PartialEq)]
pub struct BakedModel {
    pub sections: Vec<Header>,
    pub instances: Vec<ModelInstance>,
    pub inline_parts: Vec<InlinePart>,
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
    header: Header,
    lines: Vec<Line>,
}

impl Section {
    fn is_part(&self) -> bool {
        self.header
            .ldraw_org
            .as_deref()
            .and_then(|org| org.split_whitespace().next())
            .is_some_and(|kind| !kind.eq_ignore_ascii_case(MODEL_ORG))
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
    let sections: Vec<Section> = bodies
        .iter()
        .map(|body| {
            let file = ldraw::parse(body);
            Section {
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
    } = out;
    for instance in &mut instances {
        instance.matrix = Affine {
            m: instance.matrix.ldraw_to_y_up().m.map(|v| v + 0.0),
        };
    }
    Ok(BakedModel {
        sections: sections
            .into_iter()
            .enumerate()
            .filter(|(index, _)| reached.contains(index))
            .map(|(_, section)| section.header)
            .collect(),
        instances,
        inline_parts: inline_parts
            .into_iter()
            .map(|(inline, official)| InlinePart { inline, official })
            .collect(),
    })
}

#[derive(Default)]
struct WalkOutput {
    instances: Vec<ModelInstance>,
    inline_parts: BTreeMap<String, String>,
    reached: BTreeSet<usize>,
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
                    color: child_color,
                    matrix: child_matrix,
                });
            }
            Some(&child) => walk(model, child, &child_matrix, child_color, depth + 1, out)?,
            None => out.instances.push(ModelInstance {
                part: reference.clone(),
                color: child_color,
                matrix: child_matrix,
            }),
        }
    }
    Ok(())
}
