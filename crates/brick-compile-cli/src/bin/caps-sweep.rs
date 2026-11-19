use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::ExitCode;

use brick_compile::affine::Affine;
use brick_compile::connect::{Gender, ShadowSnaps, Shape};
use brick_compile::ends::{cylinder_ends, read_end, Reading};
use brick_compile::flatten::{Flattener, Library, Lod, Triangle};
use brick_compile_cli::LazyLibrary;
use serde_json::{json, Value};

const PRIMITIVE_FOLDER: &str = "p/";
const PART_FOLDER: &str = "parts";

struct PartSnapsOnly<'a>(&'a LazyLibrary);

impl Library for PartSnapsOnly<'_> {
    fn source(&self, path: &str) -> Option<&str> {
        if path.starts_with(PRIMITIVE_FOLDER) {
            None
        } else {
            self.0.source(path)
        }
    }
}

fn y_up(triangles: &[Triangle]) -> Vec<Triangle> {
    triangles
        .iter()
        .map(|t| Triangle {
            points: t.points.map(|p| Affine::LDRAW_TO_Y_UP.apply(p)),
            ..*t
        })
        .collect()
}

fn reading_json(reading: Reading) -> Value {
    match reading {
        Reading::Free => json!("free"),
        Reading::Blocked(b) => json!({ "gap": b.gap, "radius": b.radius }),
        Reading::WiderThanReach => json!("wider than a female's reach"),
    }
}

fn run() -> Result<(), String> {
    let mut values = HashMap::new();
    let mut raw = std::env::args().skip(1);
    while let Some(flag) = raw.next() {
        values.insert(flag, raw.next().unwrap_or_default());
    }
    let take = |k: &str| values.get(k).cloned().ok_or(format!("missing {k}"));
    let ldraw_root = PathBuf::from(take("--ldraw")?);
    let library = LazyLibrary::new(ldraw_root.clone());
    let shadow = LazyLibrary::new(PathBuf::from(take("--shadow")?));
    let part_snaps = PartSnapsOnly(&shadow);
    let mut names: Vec<String> = fs::read_dir(ldraw_root.join(PART_FOLDER))
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .filter(|n| n.ends_with(".dat"))
        .collect();
    names.sort();
    let mut measured = 0usize;
    let mut wider = 0usize;
    let mut rows = Vec::new();
    for name in names {
        let path = format!("{PART_FOLDER}/{name}");
        let extraction = ShadowSnaps::new(&library, &part_snaps).snaps(&path);
        let males: Vec<_> = extraction
            .connectors
            .iter()
            .filter(|c| {
                matches!(
                    c.shape,
                    Shape::Cylinder {
                        gender: Gender::Male,
                        slide: true,
                        ..
                    }
                )
            })
            .collect();
        if males.is_empty() {
            continue;
        }
        let Ok(flat) = Flattener::new(&library, Lod::Standard, &[]).flatten(&path) else {
            continue;
        };
        let triangles = y_up(&flat.triangles);
        for (index, connector) in males.iter().enumerate() {
            let Shape::Cylinder { caps, sections, .. } = &connector.shape else {
                continue;
            };
            let declared = caps.closed_ends(Gender::Male);
            for (instance, ends) in cylinder_ends(connector).iter().enumerate() {
                measured += 1;
                let start = read_end(&triangles, &ends[0]);
                let far = read_end(&triangles, &ends[1]);
                if [start, far].contains(&Reading::WiderThanReach) {
                    wider += 1;
                    continue;
                }
                let blocked = |r: Reading| matches!(r, Reading::Blocked(_));
                if (blocked(start), blocked(far)) != declared {
                    rows.push(json!({
                        "part": path,
                        "title": library.source(&path).and_then(|s| s.lines().next()).unwrap_or_default(),
                        "male": index,
                        "instance": instance,
                        "caps": format!("{caps:?}"),
                        "sections": sections
                            .iter()
                            .map(|s| format!("{:?} {} {}", s.shape, s.radius, s.length))
                            .collect::<Vec<_>>(),
                        "declaredClosed": [declared.0, declared.1],
                        "start": reading_json(start),
                        "far": reading_json(far),
                    }));
                }
            }
        }
    }
    let report = json!({
        "measuredMales": measured,
        "widerThanReach": wider,
        "disagreements": rows,
    });
    let out = take("--out")?;
    fs::write(
        &out,
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())? + "\n",
    )
    .map_err(|e| format!("{out}: {e}"))?;
    println!(
        "{measured} sliding part-level male cylinders read; {wider} wider than a female's reach; {} disagree with their caps",
        rows.len()
    );
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("caps-sweep: {message}");
            ExitCode::FAILURE
        }
    }
}
