use super::{
    Glyph, GLYPH_MAGIC, MAX_COLORS, MAX_PIXELS, MAX_SIDE_PIXELS, PIXELS_PER_STUD,
    SAMPLES_PER_PIXEL_SIDE,
};

const NARROW_PALETTE: usize = 1 << 8;
const VARINT_PAYLOAD_BITS: u32 = 7;
const VARINT_MORE: u8 = 0x80;
const VARINT_PAYLOAD: u8 = 0x7f;
const VARINT_MAX_BYTES: usize = 5;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GlyphFormatError {
    Magic,
    Truncated,
    Trailing { bytes: usize },
    Scale,
    Size,
    Palette,
    Runs,
    Coverage,
    Index,
    Outline,
    Count,
}

impl std::fmt::Display for GlyphFormatError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GlyphFormatError::Magic => write!(f, "not a plan glyph"),
            GlyphFormatError::Truncated => write!(f, "plan glyph ends early"),
            GlyphFormatError::Trailing { bytes } => {
                write!(f, "plan glyph has {bytes} bytes after its end")
            }
            GlyphFormatError::Scale => write!(
                f,
                "plan glyph is not at {PIXELS_PER_STUD} pixels a stud and {SAMPLES_PER_PIXEL_SIDE} samples a pixel side"
            ),
            GlyphFormatError::Size => write!(
                f,
                "plan glyph is empty on one side only, or larger than a glyph holds"
            ),
            GlyphFormatError::Palette => {
                write!(f, "plan glyph palette is not strictly ascending")
            }
            GlyphFormatError::Runs => write!(
                f,
                "plan glyph pixel runs are empty, repeated or don't fill its pixels"
            ),
            GlyphFormatError::Coverage => write!(
                f,
                "plan glyph covers more samples in a pixel than the pixel has"
            ),
            GlyphFormatError::Index => write!(
                f,
                "plan glyph colours a pixel past its palette, or an empty pixel"
            ),
            GlyphFormatError::Outline => write!(
                f,
                "plan glyph outline is not a closed loop of alternating x and z steps inside the glyph"
            ),
            GlyphFormatError::Count => write!(f, "plan glyph has too many entries to encode"),
        }
    }
}

fn count_u32(count: usize) -> Result<u32, GlyphFormatError> {
    u32::try_from(count).map_err(|_| GlyphFormatError::Count)
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

fn unzigzag(value: u32) -> i32 {
    (value >> 1) as i32 ^ -((value & 1) as i32)
}

struct Run {
    length: u32,
    coverage: u8,
    index: u16,
}

fn runs(glyph: &Glyph) -> Vec<Run> {
    let mut runs: Vec<Run> = Vec::new();
    for (&coverage, &index) in glyph.coverage.iter().zip(&glyph.color_index) {
        match runs.last_mut() {
            Some(run) if run.coverage == coverage && run.index == index => run.length += 1,
            _ => runs.push(Run {
                length: 1,
                coverage,
                index,
            }),
        }
    }
    runs
}

impl Glyph {
    pub fn encode(&self) -> Result<Vec<u8>, GlyphFormatError> {
        let mut out = Vec::new();
        out.extend_from_slice(GLYPH_MAGIC);
        out.push(PIXELS_PER_STUD as u8);
        out.push(SAMPLES_PER_PIXEL_SIDE as u8);
        for value in self.origin {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out.extend_from_slice(&self.width.to_le_bytes());
        out.extend_from_slice(&self.depth.to_le_bytes());
        out.extend_from_slice(&count_u32(self.colors.len())?.to_le_bytes());
        for color in &self.colors {
            out.extend_from_slice(&color.to_le_bytes());
        }
        let narrow = self.colors.len() <= NARROW_PALETTE;
        let runs = runs(self);
        out.extend_from_slice(&count_u32(runs.len())?.to_le_bytes());
        for run in &runs {
            put_varint(&mut out, run.length - 1);
            out.push(run.coverage);
            if narrow {
                out.push(run.index as u8);
            } else {
                out.extend_from_slice(&run.index.to_le_bytes());
            }
        }
        out.extend_from_slice(&count_u32(self.outline.len())?.to_le_bytes());
        for vertices in &self.outline {
            let [x0, z0] = vertices[0];
            out.extend_from_slice(&x0.to_le_bytes());
            out.extend_from_slice(&z0.to_le_bytes());
            out.extend_from_slice(&count_u32(vertices.len())?.to_le_bytes());
            for (k, vertex) in vertices.iter().enumerate() {
                let next = vertices[(k + 1) % vertices.len()];
                let axis = k % 2;
                put_varint(
                    &mut out,
                    zigzag(i32::from(next[axis]) - i32::from(vertex[axis])),
                );
            }
        }
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Glyph, GlyphFormatError> {
        let mut reader = Reader { bytes, at: 0 };
        if reader.take(GLYPH_MAGIC.len())? != GLYPH_MAGIC {
            return Err(GlyphFormatError::Magic);
        }
        let pixels_per_stud = reader.u8()?;
        let samples = reader.u8()?;
        if u32::from(pixels_per_stud) != PIXELS_PER_STUD
            || u32::from(samples) != SAMPLES_PER_PIXEL_SIDE
        {
            return Err(GlyphFormatError::Scale);
        }
        let origin = [reader.i32()?, reader.i32()?];
        let width = reader.u32()?;
        let depth = reader.u32()?;
        let area = u64::from(width) * u64::from(depth);
        if (width == 0) != (depth == 0)
            || width > MAX_SIDE_PIXELS
            || depth > MAX_SIDE_PIXELS
            || area > MAX_PIXELS
        {
            return Err(GlyphFormatError::Size);
        }
        let pixels = area as usize;
        let palette_count = reader.u32()? as usize;
        if palette_count > MAX_COLORS {
            return Err(GlyphFormatError::Count);
        }
        reader.fits(palette_count, 4)?;
        let colors = (0..palette_count)
            .map(|_| reader.u32())
            .collect::<Result<Vec<u32>, _>>()?;
        if colors.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(GlyphFormatError::Palette);
        }
        let narrow = palette_count <= NARROW_PALETTE;
        let run_count = reader.u32()? as usize;
        reader.fits(run_count, if narrow { 3 } else { 4 })?;
        let full = u16::from(samples) * u16::from(samples);
        let mut coverage = Vec::with_capacity(pixels.min(bytes.len() * 128));
        let mut color_index = Vec::with_capacity(coverage.capacity());
        let mut previous: Option<(u8, u16)> = None;
        for _ in 0..run_count {
            let length = reader.varint()? as usize + 1;
            let covered = reader.u8()?;
            let index = if narrow {
                u16::from(reader.u8()?)
            } else {
                reader.u16()?
            };
            if previous == Some((covered, index)) || coverage.len() + length > pixels {
                return Err(GlyphFormatError::Runs);
            }
            if u16::from(covered) > full {
                return Err(GlyphFormatError::Coverage);
            }
            if (covered == 0 && index != 0) || (covered > 0 && index as usize >= palette_count) {
                return Err(GlyphFormatError::Index);
            }
            previous = Some((covered, index));
            coverage.extend(std::iter::repeat_n(covered, length));
            color_index.extend(std::iter::repeat_n(index, length));
        }
        if coverage.len() != pixels {
            return Err(GlyphFormatError::Runs);
        }
        let limits = [width, depth].map(|side| u64::from(side) * u64::from(samples));
        let loop_count = reader.u32()? as usize;
        reader.fits(loop_count, 8)?;
        let mut outline = Vec::with_capacity(loop_count);
        for _ in 0..loop_count {
            outline.push(reader.outline_loop(limits)?);
        }
        if reader.at != bytes.len() {
            return Err(GlyphFormatError::Trailing {
                bytes: bytes.len() - reader.at,
            });
        }
        Ok(Glyph {
            origin,
            width,
            depth,
            colors,
            coverage,
            color_index,
            outline,
        })
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], GlyphFormatError> {
        let end = self
            .at
            .checked_add(count)
            .ok_or(GlyphFormatError::Truncated)?;
        let slice = self
            .bytes
            .get(self.at..end)
            .ok_or(GlyphFormatError::Truncated)?;
        self.at = end;
        Ok(slice)
    }

    fn fits(&self, count: usize, bytes_each: usize) -> Result<(), GlyphFormatError> {
        let needed = count
            .checked_mul(bytes_each)
            .ok_or(GlyphFormatError::Truncated)?;
        if self.bytes.len() - self.at < needed {
            return Err(GlyphFormatError::Truncated);
        }
        Ok(())
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], GlyphFormatError> {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    fn u8(&mut self) -> Result<u8, GlyphFormatError> {
        Ok(self.array::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16, GlyphFormatError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, GlyphFormatError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn i32(&mut self) -> Result<i32, GlyphFormatError> {
        Ok(i32::from_le_bytes(self.array()?))
    }

    fn varint(&mut self) -> Result<u32, GlyphFormatError> {
        let mut value: u64 = 0;
        for k in 0..VARINT_MAX_BYTES {
            let byte = self.u8()?;
            value |= u64::from(byte & VARINT_PAYLOAD) << (VARINT_PAYLOAD_BITS as usize * k);
            if byte & VARINT_MORE == 0 {
                let canonical = k == 0 || byte != 0;
                return match u32::try_from(value) {
                    Ok(value) if canonical => Ok(value),
                    _ => Err(GlyphFormatError::Count),
                };
            }
        }
        Err(GlyphFormatError::Count)
    }

    fn outline_loop(&mut self, limits: [u64; 2]) -> Result<Vec<[u16; 2]>, GlyphFormatError> {
        let start = [self.u16()?, self.u16()?];
        let count = self.u32()? as usize;
        if count < 4 || !count.is_multiple_of(2) {
            return Err(GlyphFormatError::Outline);
        }
        self.fits(count, 1)?;
        let mut vertices = Vec::with_capacity(count);
        let mut at = start.map(i64::from);
        for k in 0..count {
            if (0..2).any(|axis| at[axis] < 0 || at[axis] as u64 > limits[axis]) {
                return Err(GlyphFormatError::Outline);
            }
            vertices.push(at.map(|value| value as u16));
            let step = i64::from(unzigzag(self.varint()?));
            if step == 0 {
                return Err(GlyphFormatError::Outline);
            }
            at[k % 2] += step;
        }
        if at != start.map(i64::from) {
            return Err(GlyphFormatError::Outline);
        }
        Ok(vertices)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RUNS_AT: usize = 8 + 2 + 8 + 8 + 4 + 2 * 4 + 4;
    const RUN_BYTES: usize = 3;

    fn two_colour_glyph() -> Glyph {
        Glyph {
            origin: [-3, 5],
            width: 3,
            depth: 2,
            colors: vec![4, 16],
            coverage: vec![16, 16, 0, 8, 16, 0],
            color_index: vec![1, 1, 0, 0, 1, 0],
            outline: vec![vec![[0, 0], [8, 0], [8, 3], [5, 3], [5, 8], [0, 8]]],
        }
    }

    fn wide_palette_glyph() -> Glyph {
        let colors: Vec<u32> = (0..300).collect();
        Glyph {
            origin: [0, 0],
            width: 300,
            depth: 1,
            color_index: (0..300).collect(),
            coverage: vec![1; 300],
            colors,
            outline: vec![vec![[0, 0], [1200, 0], [1200, 4], [0, 4]]],
        }
    }

    fn encoded() -> Vec<u8> {
        two_colour_glyph().encode().expect("the glyph encodes")
    }

    fn refused(mutate: impl Fn(&mut Vec<u8>)) -> GlyphFormatError {
        let mut bytes = encoded();
        mutate(&mut bytes);
        Glyph::decode(&bytes).expect_err("the glyph is refused")
    }

    #[test]
    fn a_glyph_reads_back_exactly_as_it_was_written() {
        for glyph in [two_colour_glyph(), wide_palette_glyph(), Glyph::empty()] {
            let bytes = glyph.encode().expect("the glyph encodes");
            assert_eq!(Glyph::decode(&bytes), Ok(glyph));
        }
    }

    #[test]
    fn a_glyph_cut_short_or_padded_is_refused() {
        let bytes = encoded();
        for end in 0..bytes.len() {
            assert!(Glyph::decode(&bytes[..end]).is_err(), "{end} bytes");
        }
        assert_eq!(
            refused(|bytes| bytes.push(0)),
            GlyphFormatError::Trailing { bytes: 1 }
        );
    }

    #[test]
    fn runs_that_repeat_overfill_or_name_no_colour_are_refused() {
        let run = |k: usize| RUNS_AT + k * RUN_BYTES;
        assert_eq!(
            refused(|bytes| bytes[run(2) + 1] = 17),
            GlyphFormatError::Coverage
        );
        assert_eq!(
            refused(|bytes| bytes[run(0) + 2] = 2),
            GlyphFormatError::Index
        );
        assert_eq!(
            refused(|bytes| bytes[run(1) + 2] = 1),
            GlyphFormatError::Index
        );
        assert_eq!(
            refused(|bytes| {
                bytes[run(2) + 1] = 0;
                bytes[run(2) + 2] = 0;
            }),
            GlyphFormatError::Runs
        );
        assert_eq!(refused(|bytes| bytes[run(0)] = 9), GlyphFormatError::Runs);
    }

    #[test]
    fn an_outline_that_leaves_the_glyph_or_does_not_close_is_refused() {
        let last_step = encoded().len() - 1;
        assert_eq!(
            refused(|bytes| bytes[last_step] = zigzag(-6) as u8),
            GlyphFormatError::Outline
        );
        let first_step = last_step - 5;
        assert_eq!(
            refused(|bytes| bytes[first_step] = zigzag(13) as u8),
            GlyphFormatError::Outline
        );
    }

    #[test]
    fn a_glyph_at_another_scale_is_refused() {
        assert_eq!(refused(|bytes| bytes[8] = 16), GlyphFormatError::Scale);
        assert_eq!(refused(|bytes| bytes[..8].fill(0)), GlyphFormatError::Magic);
    }
}
