#![forbid(unsafe_code)]

use crate::reply::{Blobs, Reply};
use crate::request::{Envelope, Range};

const HEADER_LENGTH_BYTES: usize = 4;
const UNENCODABLE_REPLY: &[u8] =
    br#"{"status":"error","message":"brick-compile could not encode its reply header"}"#;

pub struct Request<'a> {
    pub envelope: Envelope,
    payload: &'a [u8],
}

impl<'a> Request<'a> {
    pub fn range(&self, (offset, length): Range) -> Result<&'a [u8], String> {
        self.payload
            .get(offset..offset + length)
            .ok_or_else(|| "a payload range runs past the request".into())
    }

    pub fn segment(&self, name: &str) -> Result<&'a [u8], String> {
        let range = self
            .envelope
            .segments
            .get(name)
            .ok_or_else(|| format!("the request has no {name} segment"))?;
        self.range(*range)
    }

    pub fn text(&self, name: &str) -> Result<String, String> {
        String::from_utf8(self.segment(name)?.to_vec())
            .map_err(|e| format!("the {name} segment is not UTF-8: {e}"))
    }
}

pub fn split(input: &[u8]) -> Result<Request<'_>, String> {
    let length_bytes: [u8; HEADER_LENGTH_BYTES] = input
        .get(..HEADER_LENGTH_BYTES)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or("request is shorter than its length prefix")?;
    let header_end = HEADER_LENGTH_BYTES
        + usize::try_from(u32::from_le_bytes(length_bytes)).map_err(|e| e.to_string())?;
    let header = input
        .get(HEADER_LENGTH_BYTES..header_end)
        .ok_or("request is shorter than its header")?;
    Ok(Request {
        envelope: serde_json::from_slice(header).map_err(|e| format!("request header: {e}"))?,
        payload: &input[header_end..],
    })
}

pub trait LittleEndian {
    fn extend_le(&self, out: &mut Vec<u8>);
}

macro_rules! little_endian {
    ($($t:ty),*) => {
        $(impl LittleEndian for $t {
            fn extend_le(&self, out: &mut Vec<u8>) {
                out.extend_from_slice(&self.to_le_bytes());
            }
        })*
    };
}

little_endian!(i16, i32, u32, f32, f64);

#[derive(Default)]
pub struct Body {
    bytes: Vec<u8>,
    blobs: Blobs,
}

impl Body {
    pub fn bytes(&mut self, bytes: &[u8]) -> Range {
        let offset = self.bytes.len();
        self.bytes.extend_from_slice(bytes);
        (offset, bytes.len())
    }

    pub fn blob<T: LittleEndian>(&mut self, name: &'static str, values: &[T]) {
        let offset = self.bytes.len();
        for value in values {
            value.extend_le(&mut self.bytes);
        }
        self.blobs.insert(name, (offset, self.bytes.len() - offset));
    }

    pub fn take_blobs(&mut self) -> Blobs {
        std::mem::take(&mut self.blobs)
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }
}

pub fn respond(reply: &Reply, body: &[u8]) -> Vec<u8> {
    match serde_json::to_vec(reply) {
        Ok(header) => framed(&header, body).unwrap_or_else(unencodable),
        Err(_) => unencodable(),
    }
}

fn framed(header: &[u8], body: &[u8]) -> Option<Vec<u8>> {
    let length = u32::try_from(header.len()).ok()?;
    let mut out = Vec::with_capacity(HEADER_LENGTH_BYTES + header.len() + body.len());
    out.extend(length.to_le_bytes());
    out.extend_from_slice(header);
    out.extend_from_slice(body);
    Some(out)
}

fn unencodable() -> Vec<u8> {
    framed(UNENCODABLE_REPLY, &[]).unwrap_or_default()
}
