use super::document::{CellPoint, Color, Font, Hull, MapDate, Point, Rect, Stroke};
use super::format::Format;
use super::node::{FromNode, Node};
use super::BlueBrickError;

const BOLD: u32 = 1;
const ITALIC: u32 = 2;
const UNDERLINE: u32 = 4;
const STRIKEOUT: u32 = 8;
const STYLE_NAMES: [(&str, u32); 5] = [
    ("Regular", 0),
    ("Bold", BOLD),
    ("Italic", ITALIC),
    ("Underline", UNDERLINE),
    ("Strikeout", STRIKEOUT),
];
const EVERY_STYLE: u32 = BOLD | ITALIC | UNDERLINE | STRIKEOUT;
const FIRST_YEAR: i32 = 1;
const LAST_YEAR: i32 = 9999;
const MONTHS: i32 = 12;
const FEBRUARY: i32 = 2;
const THIRTY_DAY_MONTHS: [i32; 4] = [4, 6, 9, 11];

impl FromNode for Color {
    fn from_node(node: &Node<'_>, _: Format) -> Result<Color, BlueBrickError> {
        let name = node.required("Name")?;
        Ok(if node.boolean("IsKnownColor")? {
            Color::Named {
                name: name.text().to_string(),
            }
        } else {
            Color::Argb {
                argb: name.as_hex()?,
            }
        })
    }
}

impl FromNode for Font {
    fn from_node(node: &Node<'_>, format: Format) -> Result<Font, BlueBrickError> {
        let style = if format.has_font_style() {
            let style = node.required("Style")?;
            font_style(style.text())
                .ok_or_else(|| style.malformed(format!("{:?} isn't a font style", style.text())))?
        } else {
            0
        };
        Ok(Font {
            family: node.string("FontFamily")?,
            size: node.number("Size")?,
            bold: style & BOLD != 0,
            italic: style & ITALIC != 0,
            underline: style & UNDERLINE != 0,
            strikeout: style & STRIKEOUT != 0,
        })
    }
}

fn font_style(text: &str) -> Option<u32> {
    let text = text.trim();
    if let Ok(flags) = text.parse::<u32>() {
        return (flags & !EVERY_STYLE == 0).then_some(flags);
    }
    text.split(',').try_fold(0, |flags, name| {
        STYLE_NAMES
            .iter()
            .find(|(known, _)| *known == name.trim())
            .map(|(_, flag)| flags | flag)
    })
}

impl FromNode for Rect {
    fn from_node(node: &Node<'_>, _: Format) -> Result<Rect, BlueBrickError> {
        Ok(Rect {
            x: node.decimal("X")?,
            y: node.decimal("Y")?,
            width: node.decimal("Width")?,
            height: node.decimal("Height")?,
        })
    }
}

impl FromNode for Point {
    fn from_node(node: &Node<'_>, _: Format) -> Result<Point, BlueBrickError> {
        Ok(Point {
            x: node.decimal("X")?,
            y: node.decimal("Y")?,
        })
    }
}

impl FromNode for CellPoint {
    fn from_node(node: &Node<'_>, _: Format) -> Result<CellPoint, BlueBrickError> {
        Ok(CellPoint {
            x: node.integer("X")?,
            y: node.integer("Y")?,
        })
    }
}

impl FromNode for Hull {
    fn from_node(node: &Node<'_>, format: Format) -> Result<Hull, BlueBrickError> {
        Ok(Hull {
            visible: node.attribute("isVisible") == Some("true"),
            color: node.read("hullColor", format)?,
            thickness: node.integer("hullThickness")?,
        })
    }
}

impl FromNode for MapDate {
    fn from_node(node: &Node<'_>, _: Format) -> Result<MapDate, BlueBrickError> {
        let date = MapDate {
            year: node.integer("Year")?,
            month: node.integer("Month")?,
            day: node.integer("Day")?,
        };
        let valid = (FIRST_YEAR..=LAST_YEAR).contains(&date.year)
            && (1..=MONTHS).contains(&date.month)
            && (1..=days_in_month(date.year, date.month)).contains(&date.day);
        valid.then_some(date).ok_or_else(|| {
            node.malformed(format!(
                "{}-{}-{} isn't a calendar date",
                date.year, date.month, date.day
            ))
        })
    }
}

fn days_in_month(year: i32, month: i32) -> i32 {
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    match month {
        FEBRUARY if leap => 29,
        FEBRUARY => 28,
        month if THIRTY_DAY_MONTHS.contains(&month) => 30,
        _ => 31,
    }
}

pub fn stroke(
    node: &Node<'_>,
    color: &str,
    thickness: &str,
    format: Format,
) -> Result<Stroke, BlueBrickError> {
    Ok(Stroke {
        color: node.read(color, format)?,
        thickness: node.number(thickness)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn font_styles_read_like_the_dotnet_flags_they_were_written_from() {
        assert_eq!(font_style("Regular"), Some(0));
        assert_eq!(font_style("Bold, Italic"), Some(BOLD | ITALIC));
        assert_eq!(
            font_style("Underline, Strikeout"),
            Some(UNDERLINE | STRIKEOUT)
        );
        assert_eq!(font_style("3"), Some(BOLD | ITALIC));
        assert_eq!(font_style("Heavy"), None);
        assert_eq!(font_style("16"), None);
        assert_eq!(font_style("bold"), None);
    }
}
