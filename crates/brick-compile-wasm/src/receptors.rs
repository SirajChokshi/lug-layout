#![forbid(unsafe_code)]

use brick_compile::lattice::AxisPose;

use crate::frame::Request;

const INSTANCE_PARTS: &str = "receptorParts";
const PART_STARTS: &str = "receptorStarts";
const SIXTEENTHS: &str = "receptorSixteenths";
const DIRECTIONS: &str = "receptorDirections";
const SEGMENTS: [&str; 4] = [INSTANCE_PARTS, PART_STARTS, SIXTEENTHS, DIRECTIONS];
const WORD_BYTES: usize = 4;
const COORDINATES: usize = 3;

pub struct DrawnReceptors {
    instance_parts: Vec<usize>,
    parts: Vec<Vec<AxisPose>>,
}

fn words(name: &str, bytes: &[u8]) -> Result<Vec<[u8; WORD_BYTES]>, String> {
    let (words, rest) = bytes.as_chunks::<WORD_BYTES>();
    if !rest.is_empty() {
        return Err(format!("the {name} segment is not whole 32-bit words"));
    }
    Ok(words.to_vec())
}

fn indices(name: &str, bytes: &[u8]) -> Result<Vec<usize>, String> {
    words(name, bytes)?
        .into_iter()
        .map(|word| usize::try_from(u32::from_le_bytes(word)).map_err(|e| e.to_string()))
        .collect()
}

fn receptor(sixteenths: &[i32], directions: &[u8], at: usize) -> Result<AxisPose, String> {
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
        if SEGMENTS.iter().all(|name| !request.has_segment(name)) {
            return Ok(DrawnReceptors::unsent(drawn));
        }
        let instance_parts = indices(INSTANCE_PARTS, request.segment(INSTANCE_PARTS)?)?;
        let starts = indices(PART_STARTS, request.segment(PART_STARTS)?)?;
        let sixteenths: Vec<i32> = words(SIXTEENTHS, request.segment(SIXTEENTHS)?)?
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
        if starts.first() != Some(&0) || starts.last() != Some(&directions.len()) {
            return Err(format!(
                "the receptor part starts must run from 0 to the {} receptors, but are {starts:?}",
                directions.len()
            ));
        }
        if let Some(range) = starts.windows(2).find(|range| range[0] > range[1]) {
            return Err(format!(
                "receptor part range {}..{} runs backwards",
                range[0], range[1]
            ));
        }
        let parts = starts
            .windows(2)
            .map(|range| {
                (range[0]..range[1])
                    .map(|at| receptor(&sixteenths, directions, at))
                    .collect()
            })
            .collect::<Result<Vec<Vec<AxisPose>>, String>>()?;
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

    pub fn of_part(&self, part: usize) -> &[AxisPose] {
        &self.parts[part]
    }
}
