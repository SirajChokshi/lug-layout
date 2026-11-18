use std::fs;
use std::os::unix::fs::symlink;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

use serde_json::{json, Value};

const MALE_UNDERSIDE: &str =
    "0 !LDCAD SNAP_CYL [gender=M] [caps=one] [secs=S 6 4] [pos=0 24 0] [grid=C 2 1 20 0]";
const FEMALE_UNDERSIDE: &str =
    "0 !LDCAD SNAP_CYL [gender=F] [caps=one] [secs=S 6 4] [pos=0 24 0] [grid=C 2 1 20 0]";
const HOLLOW: &str =
    "0 Custom Hollow Slope\n0 BFC CERTIFY CCW\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 3048a.dat\n";
const PLUG: &str = "1 16 10 20 0 6 0 0 0 4 0 0 0 6 box5.dat\n";

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

struct Scenario {
    root: PathBuf,
}

impl Scenario {
    fn new(name: &str) -> Self {
        let root =
            std::env::temp_dir().join(format!("shadow-patches-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let pinned = repo().join(".cache/ldraw");
        let parts = root.join("ldraw/parts");
        fs::create_dir_all(&parts).expect("scratch parts folder");
        symlink(pinned.join("p"), root.join("ldraw/p")).expect("link primitives");
        for entry in fs::read_dir(pinned.join("parts")).expect(
            "pinned inputs are restored; run `pnpm --filter @brr/asset-pipeline restore-ldraw`",
        ) {
            let entry = entry.expect("readable entry");
            symlink(entry.path(), parts.join(entry.file_name())).expect("link part");
        }
        fs::create_dir_all(root.join("shadow/parts")).expect("scratch shadow folder");
        fs::create_dir_all(root.join("patches/parts")).expect("scratch patches folder");
        Scenario { root }
    }

    fn part(&self, name: &str, geometry: &str, upstream: &str) -> &Self {
        fs::write(self.root.join(format!("ldraw/parts/{name}.dat")), geometry).expect("part");
        fs::write(
            self.root.join(format!("shadow/parts/{name}.dat")),
            format!("{upstream}\n"),
        )
        .expect("upstream shadow");
        self
    }

    fn manifest(&self, patches: Value, refusals: Value) -> &Self {
        let manifest = json!({ "ldraw": {}, "patches": patches, "refusals": refusals });
        fs::write(
            self.root.join("patches/manifest.json"),
            serde_json::to_string_pretty(&manifest).expect("manifest json"),
        )
        .expect("manifest");
        self
    }

    fn run(&self) -> Output {
        let tool = repo().join("tools/asset-pipeline");
        Command::new(env!("CARGO_BIN_EXE_shadow-patches"))
            .arg("--ldraw")
            .arg(self.root.join("ldraw"))
            .arg("--shadow")
            .arg(self.root.join("shadow"))
            .arg("--patches")
            .arg(self.root.join("patches"))
            .arg("--lock")
            .arg(tool.join("ldraw.lock.json"))
            .arg("--vocabulary")
            .arg(tool.join("section-vocabulary.json"))
            .arg("--inferred")
            .arg(tool.join("inferred-connectors.json"))
            .output()
            .expect("shadow-patches runs")
    }

    fn written(&self, path: &str) -> String {
        fs::read_to_string(self.root.join("patches").join(path)).expect("written file")
    }
}

impl Drop for Scenario {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn gender_entry(part: &str) -> Value {
    json!({ "added": "2026-11-18", "feature": "measuredGender", "part": part, "snap": 0, "status": "unverified" })
}

fn refusal(part: &str) -> Value {
    json!({ "added": "2026-11-18", "feature": "measuredGender", "part": part, "snap": 0 })
}

fn failure(output: &Output) -> String {
    assert!(!output.status.success(), "the run should fail");
    String::from_utf8_lossy(&output.stderr).into_owned()
}

#[test]
fn a_male_over_an_open_receptor_is_patched_female_and_cannot_be_recorded_as_a_refusal() {
    let patched = Scenario::new("patched");
    patched
        .part("hollow", HOLLOW, MALE_UNDERSIDE)
        .manifest(json!([gender_entry("hollow")]), json!([]));
    let output = patched.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let text = patched.written("parts/hollow.dat");
    assert!(text.contains(&format!("0 !LDCAD SNAP_CLEAR\n{FEMALE_UNDERSIDE}\n")));
    assert!(!text.contains("[gender=M]"));

    let refused = Scenario::new("refused-hollow");
    refused
        .part("hollow", HOLLOW, MALE_UNDERSIDE)
        .manifest(json!([]), json!([refusal("hollow")]));
    assert!(failure(&refused.run()).contains("now measures as a male its geometry contradicts"));
}

#[test]
fn a_male_its_geometry_matches_is_refused_and_cannot_be_patched() {
    let plugged = Scenario::new("plugged");
    plugged
        .part("plugged", &format!("{HOLLOW}{PLUG}"), MALE_UNDERSIDE)
        .manifest(json!([]), json!([refusal("plugged")]));
    let output = plugged.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let manifest: Value =
        serde_json::from_str(&plugged.written("manifest.json")).expect("manifest json");
    assert_eq!(
        manifest["refusals"][0]["measured"]["reason"],
        "parts/plugged.dat: snap 0's female counterpart isn't an open receptor, so its geometry doesn't contradict the male"
    );
    assert_eq!(
        manifest["refusals"][0]["upstream"]["snaps"],
        json!([MALE_UNDERSIDE])
    );

    let patched = Scenario::new("patched-plugged");
    patched
        .part("plugged", &format!("{HOLLOW}{PLUG}"), MALE_UNDERSIDE)
        .manifest(json!([gender_entry("plugged")]), json!([]));
    assert!(failure(&patched.run()).contains("isn't an open receptor"));
}

fn fails_as_patch_and_as_refusal(label: &str, geometry: &str, upstream: &str, expected: &str) {
    for (name, patches, refusals) in [
        ("as-patch", json!([gender_entry("measured")]), json!([])),
        ("as-refusal", json!([]), json!([refusal("measured")])),
    ] {
        let scenario = Scenario::new(&format!("{label}-{name}"));
        scenario
            .part("measured", geometry, upstream)
            .manifest(patches, refusals);
        assert!(failure(&scenario.run()).contains(expected), "{name}");
    }
}

#[test]
fn a_snap_that_is_not_one_male_snap_cyl_is_neither_patched_nor_refused() {
    fails_as_patch_and_as_refusal(
        "female",
        HOLLOW,
        FEMALE_UNDERSIDE,
        "isn't one male SNAP_CYL",
    );
}

#[test]
fn an_unmeasurable_receptor_is_neither_patched_nor_refused() {
    let tube = "0 Custom Open Tube\n0 BFC CERTIFY CCW\n1 16 0 24 0 20 0 0 0 -24 0 0 0 10 box4o4a.dat\n0 BFC INVERTNEXT\n1 16 0 24 0 16 0 0 0 -24 0 0 0 6 box4o4a.dat\n";
    fails_as_patch_and_as_refusal("tube", tube, MALE_UNDERSIDE, "can't be probed");
}

#[test]
fn open_receptors_off_the_sixteenth_grid_are_neither_patched_nor_refused() {
    let off_grid = MALE_UNDERSIDE.replace("[pos=0 24 0]", "[pos=0 24.01 0]");
    fails_as_patch_and_as_refusal(
        "off-grid",
        HOLLOW,
        &off_grid,
        "don't identify on the 1/16-LDU grid",
    );
}
