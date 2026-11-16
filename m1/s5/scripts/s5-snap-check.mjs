import fs from "node:fs";
import path from "node:path";

const [statePath, bundleDir, histogramFlag] = process.argv.slice(2);
if (!statePath || !bundleDir) {
  console.error("usage: node s5-snap-check.mjs <edit-state.json> <bundle/standard dir> [--histogram]");
  process.exit(2);
}

const STUD = 20;
const BASEPLATE_STUD_PHASE = 10;
const NEAR_LATTICE_MAX_LDU = 1;
const ORIENTATION_TOLERANCE = Math.sin((1 * Math.PI) / 180);
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
  const studs = gltf.extras.studs.map((s) => s.matrix);
  studCache.set(index, studs);
  return studs;
}

const mod = (v, m) => ((v % m) + m) % m;
const deviation = (v) => mod(v - BASEPLATE_STUD_PHASE + STUD / 2, STUD) - STUD / 2;

function compose(a, b) {
  const out = new Array(12);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 4; col++) {
      out[row * 4 + col] =
        a[row * 4] * b[col] + a[row * 4 + 1] * b[4 + col] + a[row * 4 + 2] * b[8 + col] + (col === 3 ? a[row * 4 + 3] : 0);
    }
  }
  return out;
}

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

function localStuds(ref) {
  let shift = [0, 0, 0];
  let instances;
  let partIds;
  if (ref.startsWith("ldraw:")) {
    const index = manifest.parts.findIndex((p) => p.id === ref);
    instances = [{ part: index, m: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] }];
    partIds = [ref];
  } else {
    const entry = manifest.models.find((m) => `omr:${m.name}` === ref);
    const model = JSON.parse(fs.readFileSync(path.join(bundleDir, entry.file), "utf8"));
    const { part, matrix } = model.instances;
    const manifestIndex = model.parts.map((id) => manifest.parts.findIndex((p) => p.id === id));
    shift = expectedShift(model.lattice);
    instances = part.map((p, i) => ({ part: manifestIndex[p], m: matrix.slice(i * 12, i * 12 + 12) }));
    partIds = part.map((p) => model.parts[p]);
  }
  const studs = [];
  instances.forEach(({ part, m }, instance) => {
    for (const stud of partStuds(part)) {
      const c = compose(m, stud);
      const upright = Math.abs(c[1]) < ORIENTATION_TOLERANCE && Math.abs(c[9]) < ORIENTATION_TOLERANCE && c[5] > 0;
      const squareYaw = Math.min(Math.abs(c[0]), Math.abs(c[8])) < ORIENTATION_TOLERANCE;
      studs.push({
        instance,
        instanceTranslation: [m[3], m[7], m[11]],
        part: partIds[instance],
        modelX: c[3],
        modelY: c[7],
        modelZ: c[11],
        localX: c[3] + shift[0],
        localZ: c[11] + shift[2],
        angled: !(upright && squareYaw),
      });
    }
  });
  return { shift, studs };
}

const poses = world.placements;
const poseViolations = [];
const shiftMismatches = [];
const perPlacement = [];
const histogram = new Map();
const rotationSignatures = new Map();
const cache = new Map();

for (let i = 0; i < poses.x.length; i++) {
  const refIndex = poses.refId[i];
  const ref = world.refs[refIndex];
  const [x, z, yPlates, rot] = [poses.x[i], poses.z[i], poses.yPlates[i], poses.rot[i]];
  if (!Number.isInteger(x) || !Number.isInteger(z) || x % STUD !== 0 || z % STUD !== 0 || !Number.isInteger(yPlates) || ![0, 1, 2, 3].includes(rot)) {
    poseViolations.push({ i, ref, x, z, yPlates, rot });
  }
  if (!cache.has(ref)) cache.set(ref, localStuds(ref));
  const local = cache.get(ref);
  const dumped = world.frameShifts[refIndex];
  if (dumped.some((v, axis) => v !== local.shift[axis])) shiftMismatches.push({ ref, dumped, expected: local.shift });
  const c = COS[rot];
  const s = SIN[rot];
  const counts = {
    studs: 0,
    exact: 0,
    nearLattice: 0,
    nearLatticeMaxLdu: 0,
    halfStud: 0,
    otherOffset: 0,
    angled: 0,
    angledWithinNearLatticeLdu: 0,
  };
  const modelFrameDeviations = new Float64Array(local.studs.length * 2);
  local.studs.forEach((stud, k) => {
    const wx = x + c * stud.localX + s * stud.localZ;
    const wz = z - s * stud.localX + c * stud.localZ;
    const dx = deviation(wx);
    const dz = deviation(wz);
    modelFrameDeviations[k * 2] = c * dx - s * dz;
    modelFrameDeviations[k * 2 + 1] = s * dx + c * dz;
    const distance = Math.max(Math.abs(dx), Math.abs(dz));
    counts.studs++;
    if (stud.angled) {
      counts.angled++;
      if (distance > 0 && distance <= NEAR_LATTICE_MAX_LDU) counts.angledWithinNearLatticeLdu++;
      return;
    }
    if (histogramFlag) {
      const bucket = distance === 0 ? "0" : distance <= 0.001 ? "<=0.001" : distance <= 0.01 ? "<=0.01" : distance <= 0.1 ? "<=0.1" : distance <= 1 ? "<=1" : distance < 9 ? "1..9" : distance <= 10 ? "9..10" : ">10";
      const key = `${ref} ${bucket}`;
      histogram.set(key, (histogram.get(key) ?? 0) + 1);
    }
    if (distance === 0) counts.exact++;
    else if (distance <= NEAR_LATTICE_MAX_LDU) {
      counts.nearLattice++;
      counts.nearLatticeMaxLdu = Math.max(counts.nearLatticeMaxLdu, distance);
    } else if (Math.abs(Math.abs(dx) - STUD / 2) <= NEAR_LATTICE_MAX_LDU || Math.abs(Math.abs(dz) - STUD / 2) <= NEAR_LATTICE_MAX_LDU) {
      counts.halfStud++;
    } else counts.otherOffset++;
  });
  if (!rotationSignatures.has(ref)) rotationSignatures.set(ref, []);
  rotationSignatures.get(ref).push({ rot, x, z, deviations: modelFrameDeviations });
  perPlacement.push({ ref, x, z, yPlates, rot, ...counts });
}

const rotationInvariance = [];
for (const [ref, placements] of rotationSignatures) {
  const [first, ...rest] = placements;
  let maxDifference = 0;
  for (const other of rest) {
    for (let k = 0; k < first.deviations.length; k++) {
      maxDifference = Math.max(maxDifference, Math.abs(deviation(BASEPLATE_STUD_PHASE + first.deviations[k] - other.deviations[k])));
    }
  }
  rotationInvariance.push({
    ref,
    placements: placements.length,
    rotations: [...new Set(placements.map((p) => p.rot))].sort(),
    maxModelFrameDeviationDifferenceLdu: maxDifference,
  });
}

const nearLatticeInstances = {};
const worst = [];
for (const [ref, local] of cache) {
  if (ref.startsWith("ldraw:")) continue;
  const near = local.studs
    .map((stud) => {
      const dx = deviation(stud.localX);
      const dz = deviation(stud.localZ);
      return { ...stud, dx, dz, distance: Math.max(Math.abs(dx), Math.abs(dz)) };
    })
    .filter((stud) => !stud.angled && stud.distance > 0 && stud.distance <= NEAR_LATTICE_MAX_LDU)
    .sort((a, b) => b.distance - a.distance);
  nearLatticeInstances[ref] = [...new Set(near.map((stud) => stud.instance))].sort((a, b) => a - b);
  const seen = new Set();
  for (const stud of near) {
    if (seen.has(stud.instance)) continue;
    seen.add(stud.instance);
    worst.push({
      ref,
      instance: stud.instance,
      part: stud.part,
      distanceLdu: stud.distance,
      modelStudYUp: [stud.modelX, stud.modelY, stud.modelZ],
      instanceTranslationYUp: stud.instanceTranslation,
    });
    if (seen.size === 6) break;
  }
}

const report = {
  definitions: {
    distance: "max over x and z of the distance from the stud's world position to the nearest baseplate stud line (x, z = 10 mod 20), in LDU, float64",
    exact: "distance 0",
    nearLattice: `upright, square-yawed stud with 0 < distance <= ${NEAR_LATTICE_MAX_LDU} LDU`,
    halfStud: `upright, square-yawed stud within ${NEAR_LATTICE_MAX_LDU} LDU of a half-stud offset on x or z`,
    otherOffset: "upright, square-yawed stud at any other offset",
    angled: "stud not upright or yawed more than 1 degree off a quarter turn",
    angledWithinNearLatticeLdu: `angled studs that happen to lie within ${NEAR_LATTICE_MAX_LDU} LDU of the lattice (already counted in angled)`,
    rotationInvariance: "each stud's deviation rotated back into the model frame, compared across every placement of the set, difference taken modulo 20 LDU",
  },
  placements: poses.x.length,
  poseViolations,
  shiftMismatches,
  rotationInvariance,
  worstNearLatticeInstances: worst,
  nearLatticeInstances,
  perPlacement,
};
if (histogramFlag) report.histogram = Object.fromEntries([...histogram].sort());
console.log(JSON.stringify(report, null, 1));
