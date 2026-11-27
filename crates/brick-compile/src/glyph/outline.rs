use rustc_hash::FxHashMap;

const WORD_BITS: usize = u64::BITS as usize;
const EAST: u8 = 0;
const SOUTH: u8 = 1;
const WEST: u8 = 2;
const NORTH: u8 = 3;
const DIRECTIONS: u8 = 4;
const NO_EDGE: u32 = u32::MAX;

pub(super) struct SampleMask {
    words: Vec<u64>,
    stride: usize,
    width: usize,
    depth: usize,
}

impl SampleMask {
    pub(super) fn new(width: usize, depth: usize) -> Self {
        let stride = width.div_ceil(WORD_BITS);
        SampleMask {
            words: vec![0; stride * depth],
            stride,
            width,
            depth,
        }
    }

    pub(super) fn set(&mut self, x: usize, z: usize) {
        self.words[z * self.stride + x / WORD_BITS] |= 1 << (x % WORD_BITS);
    }

    fn covered(&self, x: usize, z: usize) -> bool {
        x < self.width
            && z < self.depth
            && self.words[z * self.stride + x / WORD_BITS] & (1 << (x % WORD_BITS)) != 0
    }

    fn covered_at(&self, x: usize, z: usize, dx: isize, dz: isize) -> bool {
        match (x.checked_add_signed(dx), z.checked_add_signed(dz)) {
            (Some(x), Some(z)) => self.covered(x, z),
            _ => false,
        }
    }
}

pub(super) struct SampleWindow {
    pub x0: usize,
    pub z0: usize,
    pub x1: usize,
    pub z1: usize,
}

struct BoundaryEdge {
    from: [u32; 2],
    direction: u8,
}

fn advance([x, z]: [u32; 2], direction: u8) -> [u32; 2] {
    match direction {
        EAST => [x + 1, z],
        SOUTH => [x, z + 1],
        WEST => [x - 1, z],
        _ => [x, z - 1],
    }
}

fn right_of(direction: u8) -> u8 {
    (direction + 1) % DIRECTIONS
}

fn runs_along_x(direction: u8) -> bool {
    direction == EAST || direction == WEST
}

#[derive(Default)]
struct Boundary {
    edges: Vec<BoundaryEdge>,
    leaving: FxHashMap<[u32; 2], [u32; 2]>,
}

impl Boundary {
    fn of(mask: &SampleMask, window: &SampleWindow) -> Self {
        let mut boundary = Boundary::default();
        for z in window.z0..window.z1 {
            for x in window.x0..window.x1 {
                if !mask.covered(x, z) {
                    continue;
                }
                let cell = [(x - window.x0) as u32, (z - window.z0) as u32];
                let [i, j] = cell;
                if !mask.covered_at(x, z, 0, -1) {
                    boundary.push([i, j], EAST);
                }
                if !mask.covered_at(x, z, 1, 0) {
                    boundary.push([i + 1, j], SOUTH);
                }
                if !mask.covered_at(x, z, 0, 1) {
                    boundary.push([i + 1, j + 1], WEST);
                }
                if !mask.covered_at(x, z, -1, 0) {
                    boundary.push([i, j + 1], NORTH);
                }
            }
        }
        boundary
    }

    fn push(&mut self, from: [u32; 2], direction: u8) {
        let id = self.edges.len() as u32;
        self.edges.push(BoundaryEdge { from, direction });
        let slots = self.leaving.entry(from).or_insert([NO_EDGE, NO_EDGE]);
        if slots[0] == NO_EDGE {
            slots[0] = id;
        } else {
            slots[1] = id;
        }
    }

    fn after(&self, edge: &BoundaryEdge) -> u32 {
        let [first, second] = self
            .leaving
            .get(&advance(edge.from, edge.direction))
            .copied()
            .unwrap_or([NO_EDGE, NO_EDGE]);
        if second == NO_EDGE || self.edges[first as usize].direction == right_of(edge.direction) {
            first
        } else {
            second
        }
    }

    fn loops(&self) -> Vec<Vec<[u16; 2]>> {
        let mut used = vec![false; self.edges.len()];
        let mut loops = Vec::new();
        for start in 0..self.edges.len() {
            if used[start] {
                continue;
            }
            let mut directions = Vec::new();
            let mut current = start as u32;
            while current != NO_EDGE && !used[current as usize] {
                used[current as usize] = true;
                let edge = &self.edges[current as usize];
                directions.push(edge.direction);
                current = self.after(edge);
            }
            loops.push(turns(self.edges[start].from, &directions));
        }
        loops.sort_by_key(|vertices| {
            let [x0, z0] = vertices[0];
            (z0, x0, vertices[1][0])
        });
        loops
    }
}

fn turns(origin: [u32; 2], directions: &[u8]) -> Vec<[u16; 2]> {
    let count = directions.len();
    let mut corner = origin;
    let mut vertices: Vec<([u16; 2], u8)> = Vec::new();
    for (k, &direction) in directions.iter().enumerate() {
        if direction != directions[(k + count - 1) % count] {
            vertices.push(([corner[0] as u16, corner[1] as u16], direction));
        }
        corner = advance(corner, direction);
    }
    let first = vertices
        .iter()
        .enumerate()
        .filter(|(_, (_, direction))| runs_along_x(*direction))
        .min_by_key(|(_, ([x, z], direction))| (*z, *x, *direction))
        .map_or(0, |(k, _)| k);
    vertices.rotate_left(first);
    vertices.into_iter().map(|(vertex, _)| vertex).collect()
}

pub(super) fn trace(mask: &SampleMask, window: SampleWindow) -> Vec<Vec<[u16; 2]>> {
    Boundary::of(mask, &window).loops()
}
