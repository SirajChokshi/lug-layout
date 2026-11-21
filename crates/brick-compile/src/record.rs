use crate::affine::{Affine, Vec3};
use crate::compile::CompiledPart;
use crate::cover::tree_order;
use crate::flatten::StudReference;
use crate::mesh::{ColorGroup, Mesh};
use crate::round::{PlacedRound, RoundShape};

pub const RECORD_MAGIC: &[u8; 8] = b"BRRBAKE2";
const NARROW_LIMIT: usize = 1 << 16;
const MATRIX_VALUES: usize = 12;
const BOUNDS_VALUES: usize = 6;
const GROUP_HEADER_BYTES: usize = 8;
const STUD_FIXED_BYTES: usize = 4 + 2 + MATRIX_VALUES * 8;
const ROUND_VALUES: usize = 5;
const ROUND_BYTES: usize = 2 + ROUND_VALUES * 8;
const WALL: u8 = 0;
const ANNULUS: u8 = 1;
const AXES: u8 = 3;

#[derive(Clone, Debug, PartialEq)]
pub struct BakeRecord {
    pub mesh: Mesh,
    pub studs: Vec<StudReference>,
    pub rounds: Vec<PlacedRound>,
    pub whole_bounds: [Vec3; 2],
    pub tree_order: Vec<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RecordError {
    Magic,
    Truncated,
    Positions { values: usize },
    Trailing { bytes: usize },
    Count { what: &'static str },
    Index { index: usize, vertices: usize },
    Triangles { indices: usize },
    Order,
    Name,
    Round { axis: u8, kind: u8 },
}

impl std::fmt::Display for RecordError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RecordError::Magic => write!(f, "not a bake record"),
            RecordError::Truncated => write!(f, "bake record ends early"),
            RecordError::Positions { values } => {
                write!(
                    f,
                    "bake record has {values} position values, not whole vertices"
                )
            }
            RecordError::Trailing { bytes } => {
                write!(f, "bake record has {bytes} bytes after its end")
            }
            RecordError::Count { what } => write!(f, "bake record has too many {what} to encode"),
            RecordError::Index { index, vertices } => {
                write!(
                    f,
                    "bake record index {index} is past its {vertices} vertices"
                )
            }
            RecordError::Triangles { indices } => {
                write!(
                    f,
                    "bake record has a colour group of {indices} indices, not whole triangles"
                )
            }
            RecordError::Order => write!(
                f,
                "bake record tree order is not a permutation of its triangles"
            ),
            RecordError::Name => write!(f, "bake record stud primitive name is not UTF-8"),
            RecordError::Round { axis, kind } => write!(
                f,
                "bake record has a round face of kind {kind} about axis {axis}"
            ),
        }
    }
}

fn narrow(count: usize) -> bool {
    count <= NARROW_LIMIT
}

fn count_u32(value: usize, what: &'static str) -> Result<u32, RecordError> {
    u32::try_from(value).map_err(|_| RecordError::Count { what })
}

fn round_values(round: &PlacedRound) -> (u8, [f64; ROUND_VALUES]) {
    let [u, v] = round.center;
    match round.shape {
        RoundShape::Wall { radius, from, to } => (WALL, [u, v, radius, from, to]),
        RoundShape::Annulus { inner, outer, at } => (ANNULUS, [u, v, inner, outer, at]),
    }
}

fn round_of(axis: u8, kind: u8, values: [f64; ROUND_VALUES]) -> Result<PlacedRound, RecordError> {
    let [u, v, a, b, c] = values;
    let shape = match kind {
        WALL => RoundShape::Wall {
            radius: a,
            from: b,
            to: c,
        },
        ANNULUS => RoundShape::Annulus {
            inner: a,
            outer: b,
            at: c,
        },
        _ => return Err(RecordError::Round { axis, kind }),
    };
    if axis >= AXES {
        return Err(RecordError::Round { axis, kind });
    }
    Ok(PlacedRound {
        axis: usize::from(axis),
        center: [u, v],
        shape,
    })
}

fn put_indices(
    out: &mut Vec<u8>,
    values: impl Iterator<Item = usize>,
    narrow: bool,
) -> Result<(), RecordError> {
    for value in values {
        if narrow {
            let value = u16::try_from(value).map_err(|_| RecordError::Count {
                what: "narrow indices",
            })?;
            out.extend_from_slice(&value.to_le_bytes());
        } else {
            out.extend_from_slice(&count_u32(value, "indices")?.to_le_bytes());
        }
    }
    Ok(())
}

impl BakeRecord {
    pub fn of(part: &CompiledPart, whole_bounds: [Vec3; 2]) -> Self {
        let mesh = Mesh {
            positions: part.mesh.positions.clone(),
            normals: Vec::new(),
            groups: part.mesh.groups.clone(),
        };
        BakeRecord {
            tree_order: tree_order(&mesh),
            mesh,
            studs: part.studs.clone(),
            rounds: part.rounds.clone(),
            whole_bounds,
        }
    }

    pub fn encode(&self) -> Result<Vec<u8>, RecordError> {
        let values = self.mesh.positions.len();
        if !values.is_multiple_of(3) {
            return Err(RecordError::Positions { values });
        }
        let vertices = self.mesh.vertex_count();
        let mut out = Vec::new();
        out.extend_from_slice(RECORD_MAGIC);
        out.extend_from_slice(&count_u32(vertices, "vertices")?.to_le_bytes());
        out.extend_from_slice(&count_u32(self.mesh.groups.len(), "groups")?.to_le_bytes());
        out.extend_from_slice(&count_u32(self.studs.len(), "studs")?.to_le_bytes());
        out.extend_from_slice(&count_u32(self.rounds.len(), "rounds")?.to_le_bytes());
        for value in self.whole_bounds.iter().flatten() {
            out.extend_from_slice(&value.to_le_bytes());
        }
        for value in &self.mesh.positions {
            out.extend_from_slice(&value.to_le_bytes());
        }
        for group in &self.mesh.groups {
            if !group.indices.len().is_multiple_of(3) {
                return Err(RecordError::Triangles {
                    indices: group.indices.len(),
                });
            }
            out.extend_from_slice(&group.color.to_le_bytes());
            out.extend_from_slice(&count_u32(group.indices.len(), "indices")?.to_le_bytes());
        }
        let indices = self
            .mesh
            .groups
            .iter()
            .flat_map(|group| group.indices.iter().map(|&i| i as usize));
        put_indices(&mut out, indices, narrow(vertices))?;
        for stud in &self.studs {
            out.extend_from_slice(&stud.color.to_le_bytes());
            let name = stud.primitive.as_bytes();
            let length =
                u16::try_from(name.len()).map_err(|_| RecordError::Count { what: "name bytes" })?;
            out.extend_from_slice(&length.to_le_bytes());
            out.extend_from_slice(name);
            for value in &stud.matrix.m {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        for round in &self.rounds {
            let (kind, values) = round_values(round);
            let axis = u8::try_from(round.axis).map_err(|_| RecordError::Count { what: "axes" })?;
            out.extend_from_slice(&[axis, kind]);
            for value in values {
                out.extend_from_slice(&value.to_le_bytes());
            }
        }
        put_indices(
            &mut out,
            self.tree_order.iter().copied(),
            narrow(self.tree_order.len()),
        )?;
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<BakeRecord, RecordError> {
        let mut reader = Reader { bytes, at: 0 };
        if reader.take(RECORD_MAGIC.len())? != RECORD_MAGIC {
            return Err(RecordError::Magic);
        }
        let vertices = reader.u32()? as usize;
        let group_count = reader.u32()? as usize;
        let stud_count = reader.u32()? as usize;
        let round_count = reader.u32()? as usize;
        let mut bounds = [0.0; BOUNDS_VALUES];
        for value in &mut bounds {
            *value = reader.f64()?;
        }
        reader.fits(vertices, 3 * 4)?;
        let positions = (0..vertices * 3)
            .map(|_| reader.f32())
            .collect::<Result<Vec<f32>, _>>()?;
        reader.fits(group_count, GROUP_HEADER_BYTES)?;
        let mut sizes = Vec::with_capacity(group_count);
        for _ in 0..group_count {
            sizes.push((reader.u32()?, reader.u32()? as usize));
        }
        if let Some(&(_, indices)) = sizes.iter().find(|&&(_, count)| !count.is_multiple_of(3)) {
            return Err(RecordError::Triangles { indices });
        }
        let index_count = sizes
            .iter()
            .try_fold(0usize, |sum, &(_, count)| sum.checked_add(count))
            .ok_or(RecordError::Truncated)?;
        reader.fits(index_count, if narrow(vertices) { 2 } else { 4 })?;
        let mut groups = Vec::with_capacity(sizes.len());
        for (color, count) in sizes {
            let indices = (0..count)
                .map(|_| {
                    let index = reader.index(narrow(vertices))?;
                    if index >= vertices {
                        return Err(RecordError::Index { index, vertices });
                    }
                    Ok(index as u32)
                })
                .collect::<Result<Vec<u32>, _>>()?;
            groups.push(ColorGroup { color, indices });
        }
        reader.fits(stud_count, STUD_FIXED_BYTES)?;
        let mut studs = Vec::with_capacity(stud_count);
        for _ in 0..stud_count {
            let color = reader.u32()?;
            let length = reader.u16()? as usize;
            let primitive = std::str::from_utf8(reader.take(length)?)
                .map_err(|_| RecordError::Name)?
                .to_string();
            let mut m = [0.0; MATRIX_VALUES];
            for value in &mut m {
                *value = reader.f64()?;
            }
            studs.push(StudReference {
                primitive,
                color,
                matrix: Affine { m },
            });
        }
        reader.fits(round_count, ROUND_BYTES)?;
        let mut rounds = Vec::with_capacity(round_count);
        for _ in 0..round_count {
            let [axis, kind] = reader.array()?;
            let mut values = [0.0; ROUND_VALUES];
            for value in &mut values {
                *value = reader.f64()?;
            }
            rounds.push(round_of(axis, kind, values)?);
        }
        let triangles = index_count / 3;
        reader.fits(triangles, if narrow(triangles) { 2 } else { 4 })?;
        let mut seen = vec![false; triangles];
        let mut tree_order = Vec::with_capacity(triangles);
        for _ in 0..triangles {
            let triangle = reader.index(narrow(triangles))?;
            if triangle >= triangles || std::mem::replace(&mut seen[triangle], true) {
                return Err(RecordError::Order);
            }
            tree_order.push(triangle);
        }
        if reader.at != bytes.len() {
            return Err(RecordError::Trailing {
                bytes: bytes.len() - reader.at,
            });
        }
        Ok(BakeRecord {
            mesh: Mesh {
                positions,
                normals: Vec::new(),
                groups,
            },
            studs,
            rounds,
            whole_bounds: [
                [bounds[0], bounds[1], bounds[2]],
                [bounds[3], bounds[4], bounds[5]],
            ],
            tree_order,
        })
    }
}

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, length: usize) -> Result<&'a [u8], RecordError> {
        let end = self.at.checked_add(length).ok_or(RecordError::Truncated)?;
        let taken = self.bytes.get(self.at..end).ok_or(RecordError::Truncated)?;
        self.at = end;
        Ok(taken)
    }

    fn fits(&self, count: usize, each: usize) -> Result<(), RecordError> {
        let needed = count.checked_mul(each).ok_or(RecordError::Truncated)?;
        if needed > self.bytes.len() - self.at {
            return Err(RecordError::Truncated);
        }
        Ok(())
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], RecordError> {
        let mut out = [0; N];
        out.copy_from_slice(self.take(N)?);
        Ok(out)
    }

    fn u16(&mut self) -> Result<u16, RecordError> {
        Ok(u16::from_le_bytes(self.array()?))
    }

    fn u32(&mut self) -> Result<u32, RecordError> {
        Ok(u32::from_le_bytes(self.array()?))
    }

    fn f32(&mut self) -> Result<f32, RecordError> {
        Ok(f32::from_le_bytes(self.array()?))
    }

    fn f64(&mut self) -> Result<f64, RecordError> {
        Ok(f64::from_le_bytes(self.array()?))
    }

    fn index(&mut self, narrow: bool) -> Result<usize, RecordError> {
        Ok(if narrow {
            self.u16()? as usize
        } else {
            self.u32()? as usize
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const WIDE_VERTICES: usize = NARROW_LIMIT + 3;
    const NAN_WITH_PAYLOAD: u32 = 0x7fc0_1234;
    const MALFORMED_NAME: [u8; 2] = [0xff, 0xfe];
    const COUNTERS: usize = 4;

    fn special_f32() -> [f32; 6] {
        [
            -0.0,
            f32::from_bits(NAN_WITH_PAYLOAD),
            f32::INFINITY,
            f32::NEG_INFINITY,
            f32::MIN_POSITIVE / 2.0,
            1.5,
        ]
    }

    fn rounds() -> Vec<PlacedRound> {
        vec![
            PlacedRound {
                axis: 1,
                center: [-0.0, f64::from_bits(0x7ff8_0000_0000_0011)],
                shape: RoundShape::Wall {
                    radius: 20.0,
                    from: f64::NEG_INFINITY,
                    to: f64::MIN_POSITIVE / 8.0,
                },
            },
            PlacedRound {
                axis: 2,
                center: [10.0, -10.0],
                shape: RoundShape::Annulus {
                    inner: 0.0,
                    outer: f64::INFINITY,
                    at: -0.0,
                },
            },
        ]
    }

    fn round_bits(round: &PlacedRound) -> (usize, u8, [u64; ROUND_VALUES]) {
        let (kind, values) = round_values(round);
        (round.axis, kind, values.map(f64::to_bits))
    }

    fn record(vertices: usize, studs: usize) -> BakeRecord {
        let specials = special_f32();
        let positions = (0..vertices * 3)
            .map(|i| specials[i % specials.len()])
            .collect();
        let triangles = vertices / 3;
        let indices: Vec<u32> = (0..triangles * 3)
            .map(|i| ((i * 7) % vertices) as u32)
            .collect();
        let (first, second) = indices.split_at(indices.len() / 3 * 3 / 2 / 3 * 3);
        let studs = (0..studs)
            .map(|i| StudReference {
                primitive: format!("stud{i}.dat"),
                color: i as u32,
                matrix: Affine {
                    m: std::array::from_fn(|k| {
                        if k == i % MATRIX_VALUES {
                            -0.0
                        } else {
                            f64::from_bits(0x7ff8_0000_0000_0042 + k as u64)
                        }
                    }),
                },
            })
            .collect();
        BakeRecord {
            mesh: Mesh {
                positions,
                normals: Vec::new(),
                groups: vec![
                    ColorGroup {
                        color: 4,
                        indices: first.to_vec(),
                    },
                    ColorGroup {
                        color: 16,
                        indices: second.to_vec(),
                    },
                ],
            },
            studs,
            rounds: rounds(),
            whole_bounds: [
                [
                    -0.0,
                    f64::NEG_INFINITY,
                    f64::from_bits(0x7ff8_0000_0000_0007),
                ],
                [f64::INFINITY, 0.0, f64::MIN_POSITIVE / 4.0],
            ],
            tree_order: (0..triangles).rev().collect(),
        }
    }

    fn same_bits(a: &BakeRecord, b: &BakeRecord) -> bool {
        a.mesh.positions.iter().map(|v| v.to_bits()).eq(b
            .mesh
            .positions
            .iter()
            .map(|v| v.to_bits()))
            && a.mesh.groups == b.mesh.groups
            && a.studs.len() == b.studs.len()
            && a.studs.iter().zip(&b.studs).all(|(x, y)| {
                x.primitive == y.primitive
                    && x.color == y.color
                    && x.matrix.m.map(f64::to_bits) == y.matrix.m.map(f64::to_bits)
            })
            && a.rounds
                .iter()
                .map(round_bits)
                .eq(b.rounds.iter().map(round_bits))
            && a.whole_bounds.map(|c| c.map(f64::to_bits))
                == b.whole_bounds.map(|c| c.map(f64::to_bits))
            && a.tree_order == b.tree_order
    }

    #[test]
    fn a_record_keeps_every_bit_in_narrow_and_wide_encodings() {
        for vertices in [9, WIDE_VERTICES * 3] {
            let original = record(vertices, 5);
            let bytes = original.encode().expect("encode");
            let decoded = BakeRecord::decode(&bytes).expect("decode");
            assert!(same_bits(&original, &decoded), "{vertices} vertices");
            assert_eq!(decoded.encode().expect("re-encode"), bytes);
        }
        let narrow = record(9, 0).encode().expect("narrow").len();
        let wide = record(WIDE_VERTICES * 3, 0).encode().expect("wide").len();
        assert!(wide > narrow);
    }

    fn valid() -> (BakeRecord, Vec<u8>) {
        let original = record(9, 1);
        let bytes = original.encode().expect("encode");
        (original, bytes)
    }

    fn header_end() -> usize {
        RECORD_MAGIC.len() + COUNTERS * 4 + BOUNDS_VALUES * 8
    }

    fn patched(bytes: &[u8], at: usize, with: &[u8]) -> Vec<u8> {
        let mut out = bytes.to_vec();
        out[at..at + with.len()].copy_from_slice(with);
        out
    }

    #[test]
    fn decode_refuses_every_malformed_record() {
        let (original, bytes) = valid();
        assert_eq!(
            BakeRecord::decode(&patched(&bytes, 0, b"X")),
            Err(RecordError::Magic)
        );
        for length in 0..bytes.len() {
            assert!(
                BakeRecord::decode(&bytes[..length]).is_err(),
                "a {length}-byte prefix decoded"
            );
        }
        let mut longer = bytes.clone();
        longer.push(0);
        assert_eq!(
            BakeRecord::decode(&longer),
            Err(RecordError::Trailing { bytes: 1 })
        );
        let vertices = original.mesh.vertex_count();
        let positions_end = header_end() + vertices * 3 * 4;
        let indices_start = positions_end + original.mesh.groups.len() * GROUP_HEADER_BYTES;
        assert_eq!(
            BakeRecord::decode(&patched(
                &bytes,
                indices_start,
                &(vertices as u16).to_le_bytes()
            )),
            Err(RecordError::Index {
                index: vertices,
                vertices
            })
        );
        let first_count = positions_end + 4;
        let second_count = positions_end + GROUP_HEADER_BYTES + 4;
        let counts: Vec<u32> = original
            .mesh
            .groups
            .iter()
            .map(|g| g.indices.len() as u32)
            .collect();
        assert_eq!(
            BakeRecord::decode(&patched(
                &bytes,
                first_count,
                &(counts[0] + 1).to_le_bytes()
            )),
            Err(RecordError::Triangles {
                indices: counts[0] as usize + 1
            })
        );
        let shifted = patched(
            &patched(&bytes, first_count, &(counts[0] + 1).to_le_bytes()),
            second_count,
            &(counts[1] - 1).to_le_bytes(),
        );
        assert_eq!(
            BakeRecord::decode(&shifted),
            Err(RecordError::Triangles {
                indices: counts[0] as usize + 1
            }),
            "groups that sum to whole triangles but split one"
        );
        let order_start = bytes.len() - original.tree_order.len() * 2;
        assert_eq!(
            BakeRecord::decode(&patched(
                &bytes,
                order_start,
                &(original.tree_order[1] as u16).to_le_bytes()
            )),
            Err(RecordError::Order)
        );
        assert_eq!(
            BakeRecord::decode(&patched(
                &bytes,
                order_start,
                &(original.tree_order.len() as u16).to_le_bytes()
            )),
            Err(RecordError::Order)
        );
        let indices_end = indices_start
            + original
                .mesh
                .groups
                .iter()
                .map(|g| g.indices.len())
                .sum::<usize>()
                * 2;
        let name_start = indices_end + 4 + 2;
        assert_eq!(
            BakeRecord::decode(&patched(&bytes, name_start, &MALFORMED_NAME)),
            Err(RecordError::Name)
        );
        let rounds_start = order_start - original.rounds.len() * ROUND_BYTES;
        assert_eq!(
            BakeRecord::decode(&patched(&bytes, rounds_start, &[AXES, WALL])),
            Err(RecordError::Round {
                axis: AXES,
                kind: WALL
            })
        );
        assert_eq!(
            BakeRecord::decode(&patched(&bytes, rounds_start, &[1, ANNULUS + 1])),
            Err(RecordError::Round {
                axis: 1,
                kind: ANNULUS + 1
            })
        );
        for counter in 0..COUNTERS {
            let huge = patched(
                &bytes,
                RECORD_MAGIC.len() + counter * 4,
                &u32::MAX.to_le_bytes(),
            );
            assert_eq!(
                BakeRecord::decode(&huge),
                Err(RecordError::Truncated),
                "counter {counter}"
            );
        }
    }

    #[test]
    fn encode_refuses_positions_or_groups_that_are_not_whole() {
        let mut broken = record(9, 0);
        broken.mesh.positions.push(1.0);
        assert_eq!(broken.encode(), Err(RecordError::Positions { values: 28 }));
        let mut split = record(9, 0);
        let moved = split.mesh.groups[1].indices.remove(0);
        split.mesh.groups[0].indices.push(moved);
        let indices = split.mesh.groups[0].indices.len();
        assert_eq!(split.encode(), Err(RecordError::Triangles { indices }));
    }
}
