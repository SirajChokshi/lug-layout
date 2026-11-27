use quick_xml::escape::resolve_predefined_entity;
use quick_xml::events::{BytesRef, BytesStart, Event};
use quick_xml::{Reader, XmlVersion};

const MAX_DEPTH: usize = 64;
const BYTE_ORDER_MARK: char = '\u{feff}';

#[derive(Debug, Default)]
pub struct Element {
    name: String,
    attributes: Vec<(String, String)>,
    children: Vec<Element>,
    text: String,
}

impl Element {
    pub fn parse(bytes: &[u8]) -> Result<Element, String> {
        let source = std::str::from_utf8(bytes).map_err(|e| format!("it isn't UTF-8 text: {e}"))?;
        TreeBuilder::default().build(source.strip_prefix(BYTE_ORDER_MARK).unwrap_or(source))
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn attribute(&self, name: &str) -> Option<&str> {
        self.attributes
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn children(&self) -> &[Element] {
        &self.children
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    fn opened(start: &BytesStart<'_>) -> Result<Element, String> {
        let attributes = start
            .attributes()
            .map(|attribute| {
                let attribute = attribute.map_err(|e| e.to_string())?;
                let value = attribute
                    .normalized_value(XmlVersion::Implicit1_0)
                    .map_err(|e| e.to_string())?;
                Ok((attribute.key.as_ref().to_string(), value.into_owned()))
            })
            .collect::<Result<_, String>>()?;
        Ok(Element {
            name: start.name().as_ref().to_string(),
            attributes,
            ..Element::default()
        })
    }
}

#[derive(Default)]
struct TreeBuilder {
    open: Vec<Element>,
    root: Option<Element>,
}

impl TreeBuilder {
    fn build(mut self, source: &str) -> Result<Element, String> {
        let mut reader = Reader::from_str(source);
        loop {
            let event = reader
                .read_event()
                .map_err(|e| format!("{e} (at byte {})", reader.error_position()))?;
            match event {
                Event::Start(start) => self.push(Element::opened(&start)?)?,
                Event::Empty(start) => self.close(Element::opened(&start)?)?,
                Event::End(_) => {
                    let element = self.open.pop().ok_or("an end tag closes nothing")?;
                    self.close(element)?;
                }
                Event::Text(text) => self.append(&text.xml10_content())?,
                Event::CData(data) => self.append(&data.xml10_content())?,
                Event::GeneralRef(reference) => self.append(&resolved(&reference)?)?,
                Event::Decl(_) | Event::PI(_) | Event::Comment(_) | Event::DocType(_) => {}
                Event::Eof => break,
            }
        }
        if let Some(unclosed) = self.open.last() {
            return Err(format!("<{}> is never closed", unclosed.name));
        }
        self.root
            .ok_or_else(|| "it has no root element".to_string())
    }

    fn push(&mut self, element: Element) -> Result<(), String> {
        if self.open.len() >= MAX_DEPTH {
            return Err(format!("its elements nest deeper than {MAX_DEPTH} levels"));
        }
        if self.open.is_empty() && self.root.is_some() {
            return Err("it has more than one root element".to_string());
        }
        self.open.push(element);
        Ok(())
    }

    fn close(&mut self, element: Element) -> Result<(), String> {
        match self.open.last_mut() {
            Some(parent) => parent.children.push(element),
            None if self.root.is_none() => self.root = Some(element),
            None => return Err("it has more than one root element".to_string()),
        }
        Ok(())
    }

    fn append(&mut self, text: &str) -> Result<(), String> {
        match self.open.last_mut() {
            Some(element) => element.text.push_str(text),
            None if text.trim().is_empty() => {}
            None => return Err("it has text outside its root element".to_string()),
        }
        Ok(())
    }
}

fn resolved(reference: &BytesRef<'_>) -> Result<String, String> {
    if let Some(character) = reference.resolve_char_ref().map_err(|e| e.to_string())? {
        return Ok(character.to_string());
    }
    let name = reference.xml10_content();
    resolve_predefined_entity(&name)
        .map(str::to_string)
        .ok_or_else(|| format!("it refers to the undeclared entity &{name};"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_keeps_references_and_normalises_line_ends() {
        let root = Element::parse(b"<a><b>x &amp; y&#13;\r\nz</b><c><![CDATA[<d>]]></c></a>")
            .expect("well-formed");
        assert_eq!(root.children()[0].text(), "x & y\r\nz");
        assert_eq!(root.children()[1].text(), "<d>");
    }

    #[test]
    fn refuses_what_is_not_one_well_formed_tree() {
        for source in [
            "<a><b></a>",
            "<a/><b/>",
            "<a>&nbsp;</a>",
            "text<a/>",
            "<a>",
            "",
        ] {
            assert!(
                Element::parse(source.as_bytes()).is_err(),
                "{source:?} parsed"
            );
        }
        let deep = format!(
            "{}{}",
            "<a>".repeat(MAX_DEPTH + 1),
            "</a>".repeat(MAX_DEPTH + 1)
        );
        assert!(Element::parse(deep.as_bytes()).is_err());
        assert!(Element::parse(&[0x3c, 0x61, 0xff, 0x2f, 0x3e]).is_err());
    }
}
