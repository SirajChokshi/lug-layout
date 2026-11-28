use rustc_hash::FxHashMap;

use super::document::{DecimalText, ItemId};
use super::element::Element;
use super::format::Format;
use super::BlueBrickError;

pub trait FromNode: Sized {
    fn from_node(node: &Node<'_>, format: Format) -> Result<Self, BlueBrickError>;
}

pub struct Node<'a> {
    element: &'a Element,
    path: String,
}

impl<'a> Node<'a> {
    pub fn root(element: &'a Element) -> Node<'a> {
        Node {
            element,
            path: element.name().to_string(),
        }
    }

    pub fn name(&self) -> &'a str {
        self.element.name()
    }

    pub fn malformed(&self, problem: impl Into<String>) -> BlueBrickError {
        BlueBrickError::Malformed {
            path: self.path.clone(),
            problem: problem.into(),
        }
    }

    pub fn child(&self, name: &str) -> Option<Node<'a>> {
        self.element
            .children()
            .iter()
            .find(|child| child.name() == name)
            .map(|element| Node {
                element,
                path: format!("{}/{name}", self.path),
            })
    }

    pub fn required(&self, name: &str) -> Result<Node<'a>, BlueBrickError> {
        self.child(name)
            .ok_or_else(|| self.malformed(format!("has no <{name}>")))
    }

    pub fn required_any(&self, names: &[&str]) -> Result<Node<'a>, BlueBrickError> {
        names
            .iter()
            .find_map(|name| self.child(name))
            .ok_or_else(|| self.malformed(format!("has no <{}>", names.join("> or <"))))
    }

    pub fn elements(&self) -> impl Iterator<Item = Node<'a>> + '_ {
        let mut seen: FxHashMap<&str, usize> = FxHashMap::default();
        self.element.children().iter().map(move |element| {
            let position = seen.entry(element.name()).or_insert(0);
            *position += 1;
            Node {
                element,
                path: format!("{}/{}[{position}]", self.path, element.name()),
            }
        })
    }

    pub fn each<'s>(&'s self, name: &'s str) -> impl Iterator<Item = Node<'a>> + 's {
        self.element
            .children()
            .iter()
            .filter(move |child| child.name() == name)
            .enumerate()
            .map(move |(position, element)| Node {
                element,
                path: format!("{}/{name}[{}]", self.path, position + 1),
            })
    }

    pub fn attribute(&self, name: &str) -> Option<&'a str> {
        self.element.attribute(name)
    }

    pub fn id_attribute(&self) -> Result<ItemId, BlueBrickError> {
        let text = self
            .attribute("id")
            .ok_or_else(|| self.malformed("has no id attribute"))?;
        parse_id(text)
            .ok_or_else(|| self.malformed(format!("its id {text:?} isn't a whole number")))
    }

    pub fn text(&self) -> &'a str {
        self.element.text()
    }

    pub fn as_reference(&self) -> Result<Option<ItemId>, BlueBrickError> {
        let text = self.text().trim();
        if text.is_empty() {
            return Ok(None);
        }
        parse_id(text)
            .map(Some)
            .ok_or_else(|| self.malformed(format!("{text:?} isn't an id")))
    }

    pub fn as_decimal(&self) -> Result<DecimalText, BlueBrickError> {
        DecimalText::parse(self.text())
            .ok_or_else(|| self.malformed(format!("{:?} isn't a finite decimal", self.text())))
    }

    pub fn as_number(&self) -> Result<f64, BlueBrickError> {
        self.as_decimal()?
            .as_str()
            .parse::<f64>()
            .ok()
            .filter(|number| number.is_finite())
            .ok_or_else(|| self.malformed(format!("{:?} is out of range", self.text())))
    }

    pub fn as_integer(&self) -> Result<i32, BlueBrickError> {
        self.text()
            .trim()
            .parse::<i32>()
            .map_err(|_| self.malformed(format!("{:?} isn't a 32-bit integer", self.text())))
    }

    pub fn as_boolean(&self) -> Result<bool, BlueBrickError> {
        match self.text().trim() {
            "true" | "1" => Ok(true),
            "false" | "0" => Ok(false),
            other => Err(self.malformed(format!("{other:?} isn't true or false"))),
        }
    }

    pub fn as_hex(&self) -> Result<u32, BlueBrickError> {
        let text = self.text().trim();
        let shaped = !text.is_empty()
            && text.len() <= HEX_DIGITS_IN_ARGB
            && text.bytes().all(|byte| byte.is_ascii_hexdigit());
        shaped
            .then(|| u32::from_str_radix(text, HEX_RADIX).ok())
            .flatten()
            .ok_or_else(|| self.malformed(format!("{text:?} isn't an ARGB colour in hexadecimal")))
    }

    pub fn string(&self, name: &str) -> Result<String, BlueBrickError> {
        Ok(self.required(name)?.text().to_string())
    }

    pub fn decimal(&self, name: &str) -> Result<DecimalText, BlueBrickError> {
        self.required(name)?.as_decimal()
    }

    pub fn number(&self, name: &str) -> Result<f64, BlueBrickError> {
        self.required(name)?.as_number()
    }

    pub fn integer(&self, name: &str) -> Result<i32, BlueBrickError> {
        self.required(name)?.as_integer()
    }

    pub fn boolean(&self, name: &str) -> Result<bool, BlueBrickError> {
        self.required(name)?.as_boolean()
    }

    pub fn reference(&self, name: &str) -> Result<Option<ItemId>, BlueBrickError> {
        self.required(name)?.as_reference()
    }

    pub fn read<T: FromNode>(&self, name: &str, format: Format) -> Result<T, BlueBrickError> {
        T::from_node(&self.required(name)?, format)
    }
}

const HEX_RADIX: u32 = 16;
const HEX_DIGITS_IN_ARGB: usize = 8;

fn parse_id(text: &str) -> Option<ItemId> {
    let text = text.trim();
    let digits = text.strip_prefix('+').unwrap_or(text);
    (!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| digits.parse::<u64>().ok().map(ItemId::new))
        .flatten()
}
