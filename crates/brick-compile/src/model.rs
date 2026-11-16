use std::collections::HashMap;

use crate::affine::Affine;
use crate::flatten::INHERIT_COLOR;
use crate::ldraw::{self, Header, Line};

const MAX_SUBMODEL_DEPTH: usize = 32;

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
    let mut instances = Vec::new();
    walk(
        &sections,
        &index,
        0,
        &Affine::IDENTITY,
        INHERIT_COLOR,
        0,
        &mut instances,
    )?;
    for instance in &mut instances {
        instance.matrix = Affine {
            m: instance.matrix.ldraw_to_y_up().m.map(|v| v + 0.0),
        };
    }
    Ok(BakedModel {
        sections: sections.into_iter().map(|s| s.header).collect(),
        instances,
    })
}

fn walk(
    sections: &[Section],
    index: &HashMap<&str, usize>,
    section: usize,
    matrix: &Affine,
    color: u32,
    depth: usize,
    out: &mut Vec<ModelInstance>,
) -> Result<(), ModelError> {
    let Some(current) = sections.get(section) else {
        return Ok(());
    };
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
        match index.get(reference.as_str()) {
            Some(&child) => walk(
                sections,
                index,
                child,
                &child_matrix,
                child_color,
                depth + 1,
                out,
            )?,
            None => out.push(ModelInstance {
                part: reference.clone(),
                color: child_color,
                matrix: child_matrix,
            }),
        }
    }
    Ok(())
}
