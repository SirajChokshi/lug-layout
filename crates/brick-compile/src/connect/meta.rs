use std::collections::BTreeMap;

use crate::affine::{Affine, Vec3};

use super::{
    Bounding, Caps, Connector, Gender, GenericMatch, Grid, Scaling, Section, SectionShape, Shape,
    Source, Status,
};

const META_PREFIX: &str = "!LDCAD";
const IDENTITY_ROTATION: [f64; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

#[derive(Clone, Debug, PartialEq)]
pub enum Meta {
    Snap(Connector),
    Include {
        reference: String,
        placement: Affine,
        grid: Option<Grid>,
    },
    Clear {
        id: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MetaError {
    Missing {
        kind: String,
        key: &'static str,
    },
    Malformed {
        kind: String,
        key: String,
        value: String,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct ParsedMeta {
    pub meta: Meta,
    pub ignored: Vec<String>,
}

struct Params {
    kind: String,
    values: BTreeMap<String, String>,
    used: Vec<&'static str>,
}

impl Params {
    fn take(&mut self, key: &'static str) -> Option<String> {
        self.used.push(key);
        self.values.get(key).cloned()
    }

    fn malformed(&self, key: &str, value: &str) -> MetaError {
        MetaError::Malformed {
            kind: self.kind.clone(),
            key: key.to_string(),
            value: value.to_string(),
        }
    }

    fn required(&mut self, key: &'static str) -> Result<String, MetaError> {
        self.take(key).ok_or(MetaError::Missing {
            kind: self.kind.clone(),
            key,
        })
    }

    fn numbers(&mut self, key: &'static str) -> Result<Option<Vec<f64>>, MetaError> {
        let Some(value) = self.take(key) else {
            return Ok(None);
        };
        value
            .split_whitespace()
            .map(|t| finite(t).ok_or_else(|| self.malformed(key, &value)))
            .collect::<Result<Vec<f64>, _>>()
            .map(Some)
    }

    fn number(&mut self, key: &'static str) -> Result<f64, MetaError> {
        let value = self.required(key)?;
        finite(&value).ok_or_else(|| self.malformed(key, &value))
    }

    fn flag(&mut self, key: &'static str) -> Result<bool, MetaError> {
        match self.take(key) {
            None => Ok(false),
            Some(value) if value.eq_ignore_ascii_case("true") => Ok(true),
            Some(value) if value.eq_ignore_ascii_case("false") => Ok(false),
            Some(value) => Err(self.malformed(key, &value)),
        }
    }

    fn gender(&mut self, key: &'static str) -> Result<Gender, MetaError> {
        let value = self.required(key)?;
        match value.to_ascii_uppercase().as_str() {
            "M" => Ok(Gender::Male),
            "F" => Ok(Gender::Female),
            _ => Err(self.malformed(key, &value)),
        }
    }

    fn placement(&mut self) -> Result<Affine, MetaError> {
        let pos = self.numbers("pos")?;
        let ori = self.numbers("ori")?;
        let translation: Vec3 = match pos.as_deref() {
            None => [0.0; 3],
            Some([x, y, z]) => [*x, *y, *z],
            Some(_) => return Err(self.malformed("pos", &self.values["pos"].clone())),
        };
        let rotation: [f64; 9] = match ori {
            None => IDENTITY_ROTATION,
            Some(values) => values
                .try_into()
                .map_err(|_| self.malformed("ori", &self.values["ori"].clone()))?,
        };
        Ok(Affine::from_ldraw(translation, rotation))
    }

    fn grid(&mut self) -> Result<Option<Grid>, MetaError> {
        let Some(value) = self.take("grid") else {
            return Ok(None);
        };
        parse_grid(&value)
            .map(Some)
            .ok_or_else(|| self.malformed("grid", &value))
    }

    fn label(&mut self, key: &'static str) -> Option<String> {
        self.take(key)
    }

    fn ignored(&self) -> Vec<String> {
        self.values
            .keys()
            .filter(|key| !self.used.contains(&key.as_str()))
            .map(|key| format!("{}={}", key, self.values[key]))
            .collect()
    }
}

fn parse_grid(value: &str) -> Option<Grid> {
    let tokens: Vec<&str> = value.split_whitespace().collect();
    let centered_marks = tokens
        .iter()
        .filter(|t| t.eq_ignore_ascii_case("c"))
        .count();
    let axes: &[usize] = match tokens.len() - centered_marks {
        4 => &[0, 2],
        6 => &[0, 1, 2],
        _ => return None,
    };
    let mut grid = Grid {
        counts: [1; 3],
        centered: [false; 3],
        steps: [0.0; 3],
    };
    let mut rest = tokens.into_iter();
    for &axis in axes {
        let mut token = rest.next()?;
        if token.eq_ignore_ascii_case("c") {
            grid.centered[axis] = true;
            token = rest.next()?;
        }
        grid.counts[axis] = token.parse().ok().filter(|&count| count > 0)?;
    }
    for &axis in axes {
        grid.steps[axis] = finite(rest.next()?)?;
    }
    rest.next().is_none().then_some(grid)
}

fn finite(token: &str) -> Option<f64> {
    token
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn parse_sections(params: &mut Params) -> Result<Vec<Section>, MetaError> {
    let value = params.required("secs")?;
    let tokens: Vec<&str> = value.split_whitespace().collect();
    if tokens.is_empty() || !tokens.len().is_multiple_of(3) {
        return Err(params.malformed("secs", &value));
    }
    tokens
        .chunks(3)
        .map(|chunk| {
            let shape = match chunk[0].to_ascii_uppercase().as_str() {
                "R" => SectionShape::Round,
                "A" => SectionShape::Axle,
                "S" => SectionShape::Square,
                "_L" => SectionShape::FlexibleEnd,
                "L_" => SectionShape::FlexibleStart,
                _ => return Err(params.malformed("secs", &value)),
            };
            let radius = finite(chunk[1]).ok_or_else(|| params.malformed("secs", &value))?;
            let length = finite(chunk[2]).ok_or_else(|| params.malformed("secs", &value))?;
            Ok(Section {
                shape,
                radius,
                length,
            })
        })
        .collect()
}

fn parse_caps(params: &mut Params) -> Result<Caps, MetaError> {
    let value = params.required("caps")?;
    match value.to_ascii_lowercase().as_str() {
        "none" => Ok(Caps::None),
        "one" => Ok(Caps::One),
        "two" => Ok(Caps::Two),
        "a" => Ok(Caps::A),
        "b" => Ok(Caps::B),
        _ => Err(params.malformed("caps", &value)),
    }
}

fn parse_scaling(params: &mut Params) -> Result<Scaling, MetaError> {
    match params.take("scale") {
        None => Ok(Scaling::Fixed),
        Some(value) if value.eq_ignore_ascii_case("none") => Ok(Scaling::Fixed),
        Some(value) if value.eq_ignore_ascii_case("yonly") => Ok(Scaling::AlongAxis),
        Some(value) => Err(params.malformed("scale", &value)),
    }
}

fn parse_bounding(params: &mut Params) -> Result<Bounding, MetaError> {
    let value = params.required("bounding")?;
    let mut tokens = value.split_whitespace();
    let kind = tokens.next().unwrap_or_default().to_ascii_lowercase();
    let numbers: Option<Vec<f64>> = tokens.map(finite).collect();
    match (kind.as_str(), numbers.as_deref()) {
        ("sph", Some([radius])) => Ok(Bounding::Sphere { radius: *radius }),
        ("cube", Some([size])) => Ok(Bounding::Cube { size: *size }),
        ("box", Some([x, y, z])) => Ok(Bounding::Box { size: [*x, *y, *z] }),
        ("cyl", Some([radius, length])) => Ok(Bounding::Cylinder {
            radius: *radius,
            length: *length,
        }),
        _ => Err(params.malformed("bounding", &value)),
    }
}

fn parse_matching(params: &mut Params) -> Result<Option<GenericMatch>, MetaError> {
    match params.take("match") {
        None => Ok(None),
        Some(value) if value.eq_ignore_ascii_case("size") => Ok(Some(GenericMatch::Size)),
        Some(value) if value.eq_ignore_ascii_case("group") => Ok(Some(GenericMatch::Group)),
        Some(value) => Err(params.malformed("match", &value)),
    }
}

fn parse_free_placement(params: &mut Params) -> Result<bool, MetaError> {
    match params.take("placement") {
        None => Ok(false),
        Some(value) if value.eq_ignore_ascii_case("free") => Ok(true),
        Some(value) => Err(params.malformed("placement", &value)),
    }
}

fn snap(params: &mut Params, shape: Shape) -> Result<Meta, MetaError> {
    Ok(Meta::Snap(Connector {
        source: Source::Shadow,
        status: Status::Verified,
        id: params.label("id"),
        group: params.label("group"),
        shape,
        placement: params.placement()?,
        grid: params.grid()?,
    }))
}

fn meta(params: &mut Params) -> Result<Option<Meta>, MetaError> {
    let parsed = match params.kind.as_str() {
        "SNAP_CYL" => {
            let shape = Shape::Cylinder {
                gender: params.gender("gender")?,
                sections: parse_sections(params)?,
                caps: parse_caps(params)?,
                center: params.flag("center")?,
                slide: params.flag("slide")?,
                scaling: parse_scaling(params)?,
            };
            snap(params, shape)?
        }
        "SNAP_CLP" => {
            let shape = Shape::Clip {
                radius: params.number("radius")?,
                length: params.number("length")?,
                center: params.flag("center")?,
                slide: params.flag("slide")?,
            };
            snap(params, shape)?
        }
        "SNAP_FGR" => {
            let widths = params.numbers("seq")?.ok_or(MetaError::Missing {
                kind: params.kind.clone(),
                key: "seq",
            })?;
            let radius = match params.take("radius") {
                None => None,
                Some(value) => {
                    Some(finite(&value).ok_or_else(|| params.malformed("radius", &value))?)
                }
            };
            let shape = Shape::Finger {
                first: params.gender("genderofs")?,
                widths,
                radius,
                center: params.flag("center")?,
            };
            snap(params, shape)?
        }
        "SNAP_GEN" => {
            let shape = Shape::Generic {
                gender: params.gender("gender")?,
                bounding: parse_bounding(params)?,
                matching: parse_matching(params)?,
                free_placement: parse_free_placement(params)?,
            };
            snap(params, shape)?
        }
        "SNAP_INCL" => Meta::Include {
            reference: params.required("ref")?,
            placement: params.placement()?,
            grid: params.grid()?,
        },
        "SNAP_CLEAR" => Meta::Clear {
            id: params.label("id"),
        },
        _ => return Ok(None),
    };
    Ok(Some(parsed))
}

fn bracketed(text: &str) -> BTreeMap<String, String> {
    let mut values = BTreeMap::new();
    let mut rest = text;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else {
            break;
        };
        if let Some((key, value)) = rest[open + 1..open + close].split_once('=') {
            values.insert(key.trim().to_ascii_lowercase(), value.trim().to_string());
        }
        rest = &rest[open + close + 1..];
    }
    values
}

pub fn parse_metas(source: &str) -> Vec<Result<ParsedMeta, MetaError>> {
    source
        .lines()
        .filter_map(|line| {
            let rest = line.trim().strip_prefix('0')?.trim_start();
            let rest = rest.strip_prefix(META_PREFIX)?;
            if !rest.starts_with(char::is_whitespace) {
                return None;
            }
            let rest = rest.trim_start();
            let (kind, text) = rest.split_once(char::is_whitespace).unwrap_or((rest, ""));
            let mut params = Params {
                kind: kind.to_string(),
                values: bracketed(text),
                used: Vec::new(),
            };
            match meta(&mut params) {
                Ok(Some(meta)) => Some(Ok(ParsedMeta {
                    meta,
                    ignored: params.ignored(),
                })),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn only(line: &str) -> Result<ParsedMeta, MetaError> {
        let mut parsed = parse_metas(line);
        assert_eq!(parsed.len(), 1, "{line}");
        parsed.remove(0)
    }

    #[test]
    fn grids_read_two_or_three_axes_with_optional_centring() {
        let cases = [
            (
                "C 4 C 2 20 20",
                [4, 1, 2],
                [true, false, true],
                [20.0, 0.0, 20.0],
            ),
            (
                "1 C 2 0 40",
                [1, 1, 2],
                [false, false, true],
                [0.0, 0.0, 40.0],
            ),
            (
                "2 C 3 1 52 20 0",
                [2, 3, 1],
                [false, true, false],
                [52.0, 20.0, 0.0],
            ),
        ];
        for (text, counts, centered, steps) in cases {
            assert_eq!(
                parse_grid(text),
                Some(Grid {
                    counts,
                    centered,
                    steps
                }),
                "{text}"
            );
        }
        for bad in ["C 2 20", "2 2 20 20 20", "0 1 20 0", "C C 2 1 20 0"] {
            assert_eq!(parse_grid(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_cylinder_snap_keeps_its_descriptors_and_reports_unknown_parameters() {
        let parsed = only(
            "0 !LDCAD SNAP_CYL [ID=pin] [gender=M] [caps=one] [secs=R 8 2   R 6 16   _L 6.25 2] [slide=true] [mirror=none] [pos=1 2 3]",
        )
        .expect("parses");
        assert_eq!(parsed.ignored, vec!["mirror=none".to_string()]);
        let Meta::Snap(connector) = parsed.meta else {
            panic!("a snap");
        };
        assert_eq!(connector.id.as_deref(), Some("pin"));
        assert_eq!(translation_of(&connector.placement), [1.0, 2.0, 3.0]);
        assert_eq!(
            connector.shape,
            Shape::Cylinder {
                gender: Gender::Male,
                sections: vec![
                    Section {
                        shape: SectionShape::Round,
                        radius: 8.0,
                        length: 2.0
                    },
                    Section {
                        shape: SectionShape::Round,
                        radius: 6.0,
                        length: 16.0
                    },
                    Section {
                        shape: SectionShape::FlexibleEnd,
                        radius: 6.25,
                        length: 2.0
                    },
                ],
                caps: Caps::One,
                center: false,
                slide: true,
                scaling: Scaling::Fixed,
            }
        );
    }

    fn translation_of(m: &Affine) -> [f64; 3] {
        [m.m[3], m.m[7], m.m[11]]
    }

    #[test]
    fn only_live_meta_lines_count_and_commented_out_snaps_stay_comments() {
        assert!(parse_metas(
            "0 //!LDCAD SNAP_CYL [gender=F] [caps=one] [secs=R 6 4]\n0 // !LDCAD SNAP_INCL [ref=x.dat]\n0 !LDCADSNAP_CLEAR"
        )
        .is_empty());
    }

    #[test]
    fn malformed_descriptors_are_errors_not_guesses() {
        for line in [
            "0 !LDCAD SNAP_CYL [gender=X] [caps=one] [secs=R 6 4]",
            "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=Q 6 4]",
            "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=R 6]",
            "0 !LDCAD SNAP_CYL [gender=M] [secs=R 6 4]",
            "0 !LDCAD SNAP_CLP [radius=4]",
            "0 !LDCAD SNAP_INCL [pos=0 0 0]",
        ] {
            assert!(only(line).is_err(), "{line}");
        }
    }
}
