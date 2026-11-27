use super::{Glyph, GLYPH_MAGIC, PIXELS_PER_STUD, SAMPLES_PER_PIXEL_SIDE};

const NARROW_PALETTE: usize = 1 << 8;
const VARINT_PAYLOAD_BITS: u32 = 7;
const VARINT_MORE: u8 = 0x80;
const VARINT_PAYLOAD: u8 = 0x7f;

fn put_count(out: &mut Vec<u8>, count: usize) {
    out.extend_from_slice(&(count as u32).to_le_bytes());
}

fn put_varint(out: &mut Vec<u8>, mut value: u32) {
    while value > u32::from(VARINT_PAYLOAD) {
        out.push((value as u8 & VARINT_PAYLOAD) | VARINT_MORE);
        value >>= VARINT_PAYLOAD_BITS;
    }
    out.push(value as u8);
}

fn zigzag(value: i32) -> u32 {
    ((value << 1) ^ (value >> 31)) as u32
}

impl Glyph {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(GLYPH_MAGIC);
        out.push(PIXELS_PER_STUD as u8);
        out.push(SAMPLES_PER_PIXEL_SIDE as u8);
        for value in self.origin {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.depth.to_le_bytes());
        put_count(&mut out, self.colors.len());
        for color in &self.colors {
            out.extend_from_slice(&color.to_le_bytes());
        }
        let pixels: Vec<(u8, u16)> = self
            .coverage
            .iter()
            .copied()
            .zip(self.color_index.iter().copied())
            .collect();
        let runs: Vec<&[(u8, u16)]> = pixels.chunk_by(|a, b| a == b).collect();
        put_count(&mut out, runs.len());
        for run in runs {
            let (coverage, index) = run[0];
            put_varint(&mut out, run.len() as u32 - 1);
            out.push(coverage);
            if self.colors.len() <= NARROW_PALETTE {
                out.push(index as u8);
            } else {
                out.extend_from_slice(&index.to_le_bytes());
            }
        }
        put_count(&mut out, self.outline.len());
        for vertices in &self.outline {
            for value in vertices[0] {
                out.extend_from_slice(&value.to_le_bytes());
            }
            put_count(&mut out, vertices.len());
            for (k, vertex) in vertices.iter().enumerate() {
                let next = vertices[(k + 1) % vertices.len()];
                let axis = k % 2;
                put_varint(
                    &mut out,
                    zigzag(i32::from(next[axis]) - i32::from(vertex[axis])),
                );
            }
        }
        out
    }
}
