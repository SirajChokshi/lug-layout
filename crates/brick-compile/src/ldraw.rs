use crate::affine::{Affine, Vec3};
use crate::exact::Decimal;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Winding {
    Ccw,
    Cw,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Line {
    Certify(Winding),
    NoCertify,
    SetWinding(Winding),
    InvertNext,
    Subfile {
        color: u32,
        matrix: Affine,
        reference: String,
    },
    Edge {
        points: [Vec3; 2],
    },
    Triangle {
        color: u32,
        points: [Vec3; 3],
    },
    Quad {
        color: u32,
        points: [Vec3; 4],
    },
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Header {
    pub title: String,
    pub name: String,
    pub author: String,
    pub license: Option<String>,
    pub ldraw_org: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExactNumbers {
    Unavailable,
    Matrix(Box<[Decimal; 12]>),
    Points(Vec<[Decimal; 3]>),
}

#[derive(Clone, Debug, PartialEq)]
pub struct LdrawFile {
    pub header: Header,
    pub lines: Vec<Line>,
    pub exact: Vec<ExactNumbers>,
    pub unparsed: usize,
}

pub fn normalize_reference(reference: &str) -> String {
    reference.trim().replace('\\', "/").to_lowercase()
}

fn parse_color(token: &str) -> Option<u32> {
    match token
        .strip_prefix("0x")
        .or_else(|| token.strip_prefix("0X"))
    {
        Some(hex) => u32::from_str_radix(hex, 16).ok(),
        None => token.parse().ok(),
    }
}

fn parse_numbers<const N: usize>(tokens: &[&str]) -> Option<[f64; N]> {
    if tokens.len() < N {
        return None;
    }
    let mut out = [0.0; N];
    for (slot, token) in out.iter_mut().zip(tokens) {
        *slot = token.parse().ok()?;
    }
    Some(out)
}

fn exact_numbers<const N: usize>(tokens: &[&str]) -> Option<[Decimal; N]> {
    let tokens = tokens.get(..N)?;
    let parsed: Vec<Decimal> = tokens
        .iter()
        .map(|t| Decimal::parse(t))
        .collect::<Option<_>>()?;
    parsed.try_into().ok()
}

fn exact_line(kind: &str, rest: &[&str]) -> ExactNumbers {
    let numbers = rest.get(1..).unwrap_or_default();
    let found = match kind {
        "1" => exact_numbers::<SUBFILE_NUMBER_COUNT>(numbers)
            .map(|n| ExactNumbers::Matrix(Box::new(n))),
        "3" => exact_numbers::<9>(numbers).map(|n| {
            ExactNumbers::Points(
                n.chunks(3)
                    .map(|p| [p[0].clone(), p[1].clone(), p[2].clone()])
                    .collect(),
            )
        }),
        "4" => exact_numbers::<12>(numbers).map(|n| {
            ExactNumbers::Points(
                n.chunks(3)
                    .map(|p| [p[0].clone(), p[1].clone(), p[2].clone()])
                    .collect(),
            )
        }),
        _ => None,
    };
    found.unwrap_or(ExactNumbers::Unavailable)
}

fn points<const N: usize>(numbers: &[f64]) -> [Vec3; N] {
    let mut out = [[0.0; 3]; N];
    for (index, point) in out.iter_mut().enumerate() {
        *point = [
            numbers[index * 3],
            numbers[index * 3 + 1],
            numbers[index * 3 + 2],
        ];
    }
    out
}

fn parse_winding(token: Option<&&str>) -> Winding {
    match token.map(|t| t.to_ascii_uppercase()) {
        Some(t) if t == "CW" => Winding::Cw,
        _ => Winding::Ccw,
    }
}

fn parse_meta(tokens: &[&str], header: &mut Header) -> Option<Line> {
    match tokens.first().copied() {
        Some("BFC") => {
            let rest: Vec<String> = tokens[1..].iter().map(|t| t.to_ascii_uppercase()).collect();
            match rest.first().map(String::as_str) {
                Some("CERTIFY") => Some(Line::Certify(parse_winding(tokens.get(2)))),
                Some("NOCERTIFY") => Some(Line::NoCertify),
                Some("INVERTNEXT") => Some(Line::InvertNext),
                Some("CCW") => Some(Line::SetWinding(Winding::Ccw)),
                Some("CW") => Some(Line::SetWinding(Winding::Cw)),
                Some("CLIP") | Some("NOCLIP") => match rest.get(1).map(String::as_str) {
                    Some("CW") => Some(Line::SetWinding(Winding::Cw)),
                    Some("CCW") => Some(Line::SetWinding(Winding::Ccw)),
                    _ => None,
                },
                _ => None,
            }
        }
        Some("Name:") => {
            header.name = tokens[1..].join(" ");
            None
        }
        Some("Author:") => {
            header.author = tokens[1..].join(" ");
            None
        }
        Some("!LICENSE") => {
            header.license = Some(tokens[1..].join(" "));
            None
        }
        Some("!LDRAW_ORG") => {
            header.ldraw_org = Some(tokens[1..].join(" "));
            None
        }
        _ => None,
    }
}

const SUBFILE_NUMBER_COUNT: usize = 12;
const GEOMETRY_KINDS: [&str; 4] = ["1", "2", "3", "4"];

pub fn parse(source: &str) -> LdrawFile {
    parse_lines(source, false)
}

pub fn parse_exact(source: &str) -> LdrawFile {
    parse_lines(source, true)
}

fn parse_lines(source: &str, keeps_exact: bool) -> LdrawFile {
    let mut header = Header::default();
    let mut lines = Vec::new();
    let mut exact = Vec::new();
    let mut unparsed = 0;
    let mut first = true;
    for raw in source.lines() {
        let tokens: Vec<&str> = raw.split_whitespace().collect();
        let Some((kind, rest)) = tokens.split_first() else {
            continue;
        };
        if first && *kind == "0" {
            header.title = rest.join(" ");
            first = false;
            continue;
        }
        first = false;
        let parsed = match *kind {
            "0" => parse_meta(rest, &mut header),
            "1" => parse_subfile(rest),
            "2" => parse_numbers::<6>(rest.get(1..).unwrap_or_default()).map(|n| Line::Edge {
                points: points::<2>(&n),
            }),
            "3" => rest.first().and_then(|c| parse_color(c)).and_then(|color| {
                parse_numbers::<9>(&rest[1..]).map(|n| Line::Triangle {
                    color,
                    points: points::<3>(&n),
                })
            }),
            "4" => rest.first().and_then(|c| parse_color(c)).and_then(|color| {
                parse_numbers::<12>(&rest[1..]).map(|n| Line::Quad {
                    color,
                    points: points::<4>(&n),
                })
            }),
            _ => None,
        };
        match parsed {
            Some(line) => {
                if keeps_exact {
                    exact.push(exact_line(kind, rest));
                }
                lines.push(line);
            }
            None if GEOMETRY_KINDS.contains(kind) => unparsed += 1,
            None => {}
        }
    }
    LdrawFile {
        header,
        lines,
        exact,
        unparsed,
    }
}

fn parse_subfile(rest: &[&str]) -> Option<Line> {
    let color = parse_color(rest.first()?)?;
    let numbers = parse_numbers::<SUBFILE_NUMBER_COUNT>(&rest[1..])?;
    let reference = rest.get(1 + SUBFILE_NUMBER_COUNT..)?.join(" ");
    if reference.is_empty() {
        return None;
    }
    let mut rotation = [0.0; 9];
    rotation.copy_from_slice(&numbers[3..]);
    Some(Line::Subfile {
        color,
        matrix: Affine::from_ldraw([numbers[0], numbers[1], numbers[2]], rotation),
        reference: normalize_reference(&reference),
    })
}
