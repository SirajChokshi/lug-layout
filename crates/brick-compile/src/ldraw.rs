use crate::affine::{Affine, Vec3};

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
pub struct LdrawFile {
    pub header: Header,
    pub lines: Vec<Line>,
}

const MOVED_PREFIX: &str = "~Moved to ";
const MAIN_COLOR: u32 = 16;
const DAT_SUFFIX: &str = ".dat";

pub fn identity_redirect(file: &LdrawFile) -> Option<String> {
    let target = file.header.title.strip_prefix(MOVED_PREFIX)?.trim();
    let mut geometry = file.lines.iter().filter(|line| {
        matches!(
            line,
            Line::Subfile { .. } | Line::Edge { .. } | Line::Triangle { .. } | Line::Quad { .. }
        )
    });
    let only = geometry.next()?;
    if geometry.next().is_some() {
        return None;
    }
    match only {
        Line::Subfile {
            color,
            matrix,
            reference,
        } if *color == MAIN_COLOR
            && *matrix == Affine::IDENTITY
            && normalize_reference(reference)
                == format!("{}{DAT_SUFFIX}", target.to_lowercase()) =>
        {
            Some(target.to_string())
        }
        _ => None,
    }
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

pub fn parse(source: &str) -> LdrawFile {
    let mut header = Header::default();
    let mut lines = Vec::new();
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
        if let Some(line) = parsed {
            lines.push(line);
        }
    }
    LdrawFile { header, lines }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_redirect_names_the_target_only_for_a_bare_identity_reference() {
        let moved = "0 ~Moved to 74746\n0 Name: 2865.dat\n0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 74746.dat\n";
        assert_eq!(identity_redirect(&parse(moved)), Some("74746".to_string()));
        let shifted = moved.replace("1 16 0 0 0", "1 16 0 8 0");
        assert_eq!(identity_redirect(&parse(&shifted)), None);
        let recoloured = moved.replace("1 16 0 0 0", "1 4 0 0 0");
        assert_eq!(identity_redirect(&parse(&recoloured)), None);
        let extra = format!("{moved}3 16 0 0 0 1 0 0 0 0 1\n");
        assert_eq!(identity_redirect(&parse(&extra)), None);
        let elsewhere = moved.replace("74746.dat", "3001.dat");
        assert_eq!(identity_redirect(&parse(&elsewhere)), None);
        let plain = "0 Brick 2 x 4\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001s01.dat\n";
        assert_eq!(identity_redirect(&parse(plain)), None);
    }
}
