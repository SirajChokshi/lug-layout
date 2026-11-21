#![forbid(unsafe_code)]

use brick_compile::connect::{FaceSection, SnapShape};
use brick_compile::lattice::{AxisPose, LatticeReceptor};

use crate::frame::Request;

const INSTANCE_PARTS: &str = "receptorParts";
const PART_STARTS: &str = "receptorStarts";
const SIXTEENTHS: &str = "receptorSixteenths";
const DIRECTIONS: &str = "receptorDirections";
const POSE_SEGMENTS: [&str; 4] = [INSTANCE_PARTS, PART_STARTS, SIXTEENTHS, DIRECTIONS];
const CAPS: &str = "receptorCaps";
const SLIDES: &str = "receptorSlides";
const GROUPS: &str = "receptorGroups";
const SECTION_STARTS: &str = "receptorSectionStarts";
const SECTION_CODES: &str = "receptorSectionCodes";
const SECTION_SIZES: &str = "receptorSectionSizes";
const SECTION_LENGTHS: &str = "receptorSectionLengths";
const SHAPE_SEGMENTS: [&str; 7] = [
    CAPS,
    SLIDES,
    GROUPS,
    SECTION_STARTS,
    SECTION_CODES,
    SECTION_SIZES,
    SECTION_LENGTHS,
];
const WORD_BYTES: usize = 4;
const DOUBLE_BYTES: usize = 8;
const COORDINATES: usize = 3;

pub struct DrawnReceptors {
    instance_parts: Vec<usize>,
    parts: Vec<Vec<LatticeReceptor>>,
}

fn chunks<const N: usize>(name: &str, bytes: &[u8]) -> Result<Vec<[u8; N]>, String> {
    let (chunks, rest) = bytes.as_chunks::<N>();
    if !rest.is_empty() {
        return Err(format!("the {name} segment is not whole {N}-byte values"));
    }
    Ok(chunks.to_vec())
}

fn indices(name: &str, bytes: &[u8]) -> Result<Vec<usize>, String> {
    chunks::<WORD_BYTES>(name, bytes)?
        .into_iter()
        .map(|word| usize::try_from(u32::from_le_bytes(word)).map_err(|e| e.to_string()))
        .collect()
}

fn doubles(name: &str, bytes: &[u8]) -> Result<Vec<f64>, String> {
    Ok(chunks::<DOUBLE_BYTES>(name, bytes)?
        .into_iter()
        .map(f64::from_le_bytes)
        .collect())
}

fn starts_cover(name: &str, starts: &[usize], count: usize, of: &str) -> Result<(), String> {
    if starts.first() != Some(&0) || starts.last() != Some(&count) {
        return Err(format!(
            "the {name} must run from 0 to the {count} {of}, but are {starts:?}"
        ));
    }
    if let Some(range) = starts.windows(2).find(|range| range[0] > range[1]) {
        return Err(format!(
            "{name} range {}..{} runs backwards",
            range[0], range[1]
        ));
    }
    Ok(())
}

fn one_each(name: &str, found: usize, wanted: usize, of: &str) -> Result<(), String> {
    if found == wanted {
        Ok(())
    } else {
        Err(format!(
            "the {name} segment has {found} values for {wanted} {of}"
        ))
    }
}

struct Shapes<'a> {
    caps: &'a [u8],
    slides: &'a [u8],
    groups: Vec<String>,
    section_starts: Vec<usize>,
    codes: &'a [u8],
    sizes: Vec<f64>,
    lengths: Vec<f64>,
}

impl<'a> Shapes<'a> {
    fn read(request: &Request<'a>, receptors: usize) -> Result<Option<Shapes<'a>>, String> {
        let sent = SHAPE_SEGMENTS
            .iter()
            .filter(|name| request.has_segment(name))
            .count();
        if sent == 0 {
            return Ok(None);
        }
        if sent < SHAPE_SEGMENTS.len() {
            return Err(format!(
                "the bake got {sent} of the {} receptor shape segments",
                SHAPE_SEGMENTS.len()
            ));
        }
        let shapes = Shapes {
            caps: request.segment(CAPS)?,
            slides: request.segment(SLIDES)?,
            groups: serde_json::from_slice(request.segment(GROUPS)?)
                .map_err(|e| format!("the {GROUPS} segment is not a list of strings: {e}"))?,
            section_starts: indices(SECTION_STARTS, request.segment(SECTION_STARTS)?)?,
            codes: request.segment(SECTION_CODES)?,
            sizes: doubles(SECTION_SIZES, request.segment(SECTION_SIZES)?)?,
            lengths: doubles(SECTION_LENGTHS, request.segment(SECTION_LENGTHS)?)?,
        };
        let sections = shapes.codes.len();
        one_each(CAPS, shapes.caps.len(), receptors, "receptors")?;
        one_each(SLIDES, shapes.slides.len(), receptors, "receptors")?;
        one_each(GROUPS, shapes.groups.len(), receptors, "receptors")?;
        one_each(
            SECTION_SIZES,
            shapes.sizes.len(),
            sections,
            "receptor sections",
        )?;
        one_each(
            SECTION_LENGTHS,
            shapes.lengths.len(),
            sections,
            "receptor sections",
        )?;
        one_each(
            SECTION_STARTS,
            shapes.section_starts.len(),
            receptors + 1,
            "receptor bounds",
        )?;
        starts_cover(
            "receptor section starts",
            &shapes.section_starts,
            sections,
            "receptor sections",
        )?;
        Ok(Some(shapes))
    }

    fn shape(&self, at: usize) -> Result<SnapShape, String> {
        let slide = match self.slides[at] {
            0 => false,
            1 => true,
            other => return Err(format!("receptor {at} has slide {other}, not 0 or 1")),
        };
        let sections: Vec<FaceSection> = (self.section_starts[at]..self.section_starts[at + 1])
            .map(|s| FaceSection {
                code: self.codes[s],
                size: self.sizes[s],
                length: self.lengths[s],
            })
            .collect();
        SnapShape::new(self.caps[at], slide, Some(&self.groups[at]), &sections)
            .map_err(|e| format!("receptor {at}: {e}"))
    }
}

fn pose(sixteenths: &[i32], directions: &[u8], at: usize) -> Result<AxisPose, String> {
    let origin = COORDINATES * at;
    AxisPose::of_face(
        [
            sixteenths[origin],
            sixteenths[origin + 1],
            sixteenths[origin + 2],
        ],
        directions[at],
    )
    .ok_or_else(|| format!("receptor {at} has direction {}, not 0 to 5", directions[at]))
}

impl DrawnReceptors {
    pub fn read(request: &Request, drawn: usize) -> Result<DrawnReceptors, String> {
        if POSE_SEGMENTS.iter().all(|name| !request.has_segment(name)) {
            return Ok(DrawnReceptors::unsent(drawn));
        }
        let instance_parts = indices(INSTANCE_PARTS, request.segment(INSTANCE_PARTS)?)?;
        let starts = indices(PART_STARTS, request.segment(PART_STARTS)?)?;
        let sixteenths: Vec<i32> = chunks::<WORD_BYTES>(SIXTEENTHS, request.segment(SIXTEENTHS)?)?
            .into_iter()
            .map(i32::from_le_bytes)
            .collect();
        let directions = request.segment(DIRECTIONS)?;
        if instance_parts.len() != drawn {
            return Err(format!(
                "the bake got receptors for {} instances, but {drawn} are drawn",
                instance_parts.len()
            ));
        }
        if sixteenths.len() != COORDINATES * directions.len() {
            return Err(format!(
                "the bake got {} receptor directions but {} receptor coordinates",
                directions.len(),
                sixteenths.len()
            ));
        }
        starts_cover(
            "receptor part starts",
            &starts,
            directions.len(),
            "receptors",
        )?;
        let shapes = Shapes::read(request, directions.len())?;
        let receptor = |at: usize| -> Result<Option<LatticeReceptor>, String> {
            let pose = pose(&sixteenths, directions, at)?;
            let Some(shapes) = &shapes else {
                return Ok(None);
            };
            Ok(Some(LatticeReceptor {
                pose,
                shape: shapes.shape(at)?,
            }))
        };
        let parts = starts
            .windows(2)
            .map(|range| {
                (range[0]..range[1])
                    .filter_map(|at| receptor(at).transpose())
                    .collect()
            })
            .collect::<Result<Vec<Vec<LatticeReceptor>>, String>>()?;
        if let Some(&part) = instance_parts.iter().find(|&&part| part >= parts.len()) {
            return Err(format!(
                "an instance names receptor part {part}, but the bake got {}",
                parts.len()
            ));
        }
        Ok(DrawnReceptors {
            instance_parts,
            parts,
        })
    }

    fn unsent(drawn: usize) -> DrawnReceptors {
        DrawnReceptors {
            instance_parts: vec![0; drawn],
            parts: vec![Vec::new()],
        }
    }

    pub fn part_of(&self, instance: usize) -> usize {
        self.instance_parts[instance]
    }

    pub fn of_part(&self, part: usize) -> &[LatticeReceptor] {
        &self.parts[part]
    }
}
