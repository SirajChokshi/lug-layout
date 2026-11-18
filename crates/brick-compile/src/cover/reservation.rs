use std::mem::size_of;

use super::cell_range;
use crate::affine::Vec3;
use crate::lattice::STUD_LDU;

type Wasm32Usize = u32;

const WASM32_BYTES_PER_CELL: i128 =
    (2 * size_of::<f64>() + 2 * size_of::<i32>() + 2 * size_of::<Wasm32Usize>()) as i128;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CellsCause {
    BeyondAddressSpace,
    MemoryUnavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CellsTooLarge {
    pub width: i128,
    pub depth: i128,
    pub cause: CellsCause,
}

impl CellsCause {
    pub fn depends_on_machine(self) -> bool {
        match self {
            CellsCause::BeyondAddressSpace => false,
            CellsCause::MemoryUnavailable => true,
        }
    }
}

impl std::fmt::Display for CellsTooLarge {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let CellsTooLarge {
            width,
            depth,
            cause,
        } = self;
        match cause {
            CellsCause::BeyondAddressSpace => write!(
                f,
                "a stud cover of {width} × {depth} cells needs more memory than the {}-bit WASM compiler can address",
                Wasm32Usize::BITS
            ),
            CellsCause::MemoryUnavailable => write!(
                f,
                "a stud cover of {width} × {depth} cells needs more memory than this machine could reserve"
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AxisSpan {
    pub from: usize,
    pub to: usize,
    pub ldu: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelTooLarge {
    pub cells: CellsTooLarge,
    pub x: AxisSpan,
    pub z: AxisSpan,
}

pub(super) struct CellColumns {
    pub(super) width: usize,
    pub(super) depth: usize,
    pub(super) count: usize,
    pub(super) lowest: Vec<f64>,
    pub(super) highest: Vec<f64>,
    pub(super) bottom: Vec<i32>,
    pub(super) top: Vec<i32>,
    pub(super) footprint: Vec<usize>,
    pub(super) flat: Vec<usize>,
}

impl CellColumns {
    pub(super) fn reserve(width: i128, depth: i128) -> Result<Self, CellsTooLarge> {
        let beyond = |cause| CellsTooLarge {
            width,
            depth,
            cause,
        };
        let overflow = beyond(CellsCause::BeyondAddressSpace);
        let too_large = beyond(CellsCause::MemoryUnavailable);
        let count = width.checked_mul(depth).ok_or(overflow)?;
        count
            .checked_mul(WASM32_BYTES_PER_CELL)
            .and_then(|bytes| Wasm32Usize::try_from(bytes).ok())
            .ok_or(overflow)?;
        let host = |cells: i128| usize::try_from(cells).map_err(|_| overflow);
        let (width, depth, count) = (host(width)?, host(depth)?, host(count)?);
        Ok(CellColumns {
            width,
            depth,
            count,
            lowest: reserved(count, too_large)?,
            highest: reserved(count, too_large)?,
            bottom: reserved(count, too_large)?,
            top: reserved(count, too_large)?,
            footprint: reserved(count, too_large)?,
            flat: reserved(count, too_large)?,
        })
    }
}

fn reserved<T>(count: usize, too_large: CellsTooLarge) -> Result<Vec<T>, CellsTooLarge> {
    let mut cells = Vec::new();
    cells.try_reserve_exact(count).map_err(|_| too_large)?;
    Ok(cells)
}

pub(super) fn axis_span(boxes: &[[Vec3; 2]], axis: usize) -> AxisSpan {
    let extreme = |corner: usize, nearer: fn(f64, f64) -> bool| {
        (0..boxes.len())
            .reduce(|kept, i| {
                if nearer(boxes[i][corner][axis], boxes[kept][corner][axis]) {
                    i
                } else {
                    kept
                }
            })
            .unwrap_or(0)
    };
    let from = extreme(0, |a, b| a < b);
    let to = extreme(1, |a, b| a > b);
    AxisSpan {
        from,
        to,
        ldu: boxes.get(to).map_or(0.0, |b| b[1][axis])
            - boxes.get(from).map_or(0.0, |b| b[0][axis]),
    }
}

pub(super) fn cell_span((first, last): (i64, i64)) -> i128 {
    i128::from(last) - i128::from(first) + 1
}

pub fn part_cover_fits([min, max]: [Vec3; 2]) -> Result<(), CellsTooLarge> {
    let widest = |axis: usize| {
        (0..STUD_LDU as u32)
            .map(|phase| cell_span(cell_range(min[axis], max[axis], f64::from(phase))))
            .fold(0, i128::max)
    };
    CellColumns::reserve(widest(0), widest(2)).map(drop)
}
