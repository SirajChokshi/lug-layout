import fs from "node:fs";
import path from "node:path";

const [statePath, bundleDir] = process.argv.slice(2);
if (!statePath || !bundleDir) {
  console.error("usage: node s5-snap-check.mjs <edit-state.json> <bundle/standard dir>");
  process.exit(2);
}

const STUD = 20;
const PLATE = 8;
const BASEPLATE_STUD_PHASE = 10;
const COS = [1, 0, -1, 0];
const SIN = [0, 1, 0, -1];

const { world } = JSON.parse(fs.readFileSync(statePath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8"));

const studCache = new Map();
function partStuds(index) {
  if (studCache.has(index)) return studCache.get(index);
  const bytes = fs.readFileSync(path.join(bundleDir, manifest.parts[index].file));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  const studs = gltf.extras.studs.map((s) => [s.matrix[3], s.matrix[7], s.matrix[11]]);
  studCache.set(index, studs);
  return studs;
}

const mod = (v, m) => ((v % m) + m) % m;

function expectedShift(lattice) {
  const shiftX = BASEPLATE_STUD_PHASE - lattice.phase[0];
  const shiftZ = BASEPLATE_STUD_PHASE - lattice.phase[1];
  const centreX = (lattice.aabb.min[0] + lattice.aabb.max[0]) / 2 + shiftX;
  const centreZ = (lattice.aabb.min[2] + lattice.aabb.max[2]) / 2 + shiftZ;
  return [
    shiftX - Math.round(centreX / STUD) * STUD,
    -lattice.aabb.min[1],
    shiftZ - Math.round(centreZ / STUD) * STUD,
  ];
}

function localInstances(ref) {
  if (ref.startsWith("ldraw:")) {
    const index = manifest.parts.findIndex((p) => p.id === ref);
    return {
      shift: [0, 0, 0],
      lattice: null,
      instances: [{ part: index, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }],
    };
  }
  const entry = manifest.models.find((m) => `omr:${m.name}` === ref);
  const model = JSON.parse(fs.readFileSync(path.join(bundleDir, entry.file), "utf8"));
  const { part, matrix } = model.instances;
  const manifestIndex = model.parts.map((id) => manifest.parts.findIndex((p) => p.id === id));
  return {
    shift: expectedShift(model.lattice),
    lattice: model.lattice,
    instances: part.map((p, i) => ({ part: manifestIndex[p], m: matrix.slice(i * 12, i * 12 + 12) })),
  };
}

const poses = world.placements;
const report = { placements: poses.x.length, poseViolations: [], shiftMismatches: [], perPlacement: [] };
let phaseLayerMaxDeviation = 0;
let phaseLayerStuds = 0;
const cache = new Map();
for (let i = 0; i < poses.x.length; i++) {
  const ref = world.refs[poses.refId[i]];
  const [x, z, yPlates, rot] = [poses.x[i], poses.z[i], poses.yPlates[i], poses.rot[i]];
  if (!Number.isInteger(x) || !Number.isInteger(z) || x % STUD !== 0 || z % STUD !== 0 || !Number.isInteger(yPlates) || ![0, 1, 2, 3].includes(rot)) {
    report.poseViolations.push({ i, ref, x, z, yPlates, rot });
  }
  if (!cache.has(ref)) cache.set(ref, localInstances(ref));
  const local = cache.get(ref);
  const dumpedShift = world.frameShifts[poses.refId[i]];
  if (dumpedShift.some((v, axis) => v !== local.shift[axis])) {
    report.shiftMismatches.push({ ref, dumpedShift, expected: local.shift });
  }
  const c = COS[rot];
  const s = SIN[rot];
  let studs = 0;
  let onPhase = 0;
  let integerOtherPhase = 0;
  let nonInteger = 0;
  let layerStuds = 0;
  let layerMax = 0;
  for (const { part, m } of local.instances) {
    for (const [sx, sy, sz] of partStuds(part)) {
      const lx = m[0] * sx + m[1] * sy + m[2] * sz + m[3] + local.shift[0];
            const lz = m[8] * sx + m[9] * sy + m[10] * sz + m[11] + local.shift[2];
      const wx = x + c * lx + s * lz;
      const wz = z - s * lx + c * lz;
      studs++;
      const devX = mod(wx - BASEPLATE_STUD_PHASE + STUD / 2, STUD) - STUD / 2;
      const devZ = mod(wz - BASEPLATE_STUD_PHASE + STUD / 2, STUD) - STUD / 2;
      const deviation = Math.max(Math.abs(devX), Math.abs(devZ));
      if (deviation === 0) onPhase++;
      else if (Number.isInteger(wx) && Number.isInteger(wz)) integerOtherPhase++;
      else nonInteger++;
      const modelX = lx - local.shift[0];
      const modelZ = lz - local.shift[2];
      const onModelLattice =
        local.lattice === null ||
        (mod(modelX, STUD) === local.lattice.phase[0] && mod(modelZ, STUD) === local.lattice.phase[1]);
      if (onModelLattice) {
        layerStuds++;
        layerMax = Math.max(layerMax, deviation);
      }
    }
  }
  phaseLayerStuds += layerStuds;
  phaseLayerMaxDeviation = Math.max(phaseLayerMaxDeviation, layerMax);
  report.perPlacement.push({
    ref,
    x,
    z,
    yPlates,
    rot,
    yLdu: yPlates * PLATE,
    studs,
    studsOnBaseplatePhase: onPhase,
    studsOnOtherIntegerPhase: integerOtherPhase,
    studsOffIntegerLattice: nonInteger,
    studsOnModelLattice: layerStuds,
    modelLatticeMaxDeviationLdu: layerMax,
  });
}
report.studsOnModelLattice = phaseLayerStuds;
report.modelLatticeMaxDeviationLdu = phaseLayerMaxDeviation;
console.log(JSON.stringify(report, null, 1));
