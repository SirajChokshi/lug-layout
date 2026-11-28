use std::collections::HashSet;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Colour {
    pub name: String,
    pub code: u32,
    pub rgb: [u8; 3],
    pub alpha: u8,
}

const OPAQUE: u8 = 255;

fn parse_hex_rgb(token: &str) -> Option<[u8; 3]> {
    let hex = token.strip_prefix('#')?;
    if hex.len() != 6 {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(&hex[i..i + 2], 16).ok();
    Some([channel(0)?, channel(2)?, channel(4)?])
}

fn value_after<'a>(tokens: &[&'a str], key: &str) -> Option<&'a str> {
    let position = tokens.iter().position(|t| *t == key)?;
    tokens.get(position + 1).copied()
}

pub fn translucent_codes(colours: &[Colour]) -> HashSet<u32> {
    colours
        .iter()
        .filter(|colour| colour.alpha < OPAQUE)
        .map(|colour| colour.code)
        .collect()
}

pub fn parse_ldconfig(source: &str) -> Vec<Colour> {
    source
        .lines()
        .filter_map(|line| {
            let tokens: Vec<&str> = line.split_whitespace().collect();
            if tokens.get(..2) != Some(&["0", "!COLOUR"]) {
                return None;
            }
            Some(Colour {
                name: tokens.get(2)?.to_string(),
                code: value_after(&tokens, "CODE")?.parse().ok()?,
                rgb: parse_hex_rgb(value_after(&tokens, "VALUE")?)?,
                alpha: value_after(&tokens, "ALPHA")
                    .and_then(|a| a.parse().ok())
                    .unwrap_or(OPAQUE),
            })
        })
        .collect()
}
