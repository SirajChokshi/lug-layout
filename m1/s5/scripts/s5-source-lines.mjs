import fs from "node:fs";
import path from "node:path";

const [reportPath, omrDir, bundleDir] = process.argv.slice(2);
if (!reportPath || !omrDir || !bundleDir) {
  console.error("usage: node s5-source-lines.mjs <snap-check.json> <.cache/omr dir> <bundle/standard dir>");
  process.exit(2);
}
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "manifest.json"), "utf8"));
const normalize = (reference) => reference.trim().replace(/\\/gu, "/").toLowerCase();
const isFractional = (v) => !Number.isInteger(v);

function sections(text) {
  const names = [];
  const bodies = [];
  text.split(/\r?\n/u).forEach((line, i) => {
    const tokens = line.trim().split(/\s+/u);
    if (tokens[0] === "0" && tokens[1]?.toUpperCase() === "FILE") {
      names.push(normalize(tokens.slice(2).join(" ")));
      bodies.push([]);
      return;
    }
    if (bodies.length === 0) {
      names.push("");
      bodies.push([]);
    }
    bodies.at(-1).push({ line: i + 1, text: line.trim() });
  });
  return names.map((name, i) => {
    const lines = bodies[i];
    const org = lines.find((l) => /^0\s+!LDRAW_ORG\s+/iu.test(l.text));
    const kind = org ? org.text.split(/\s+/u)[2] : undefined;
    return { name, lines, isPart: kind !== undefined && kind.toLowerCase() !== "model" };
  });
}

function flatten(text) {
  const all = sections(text);
  const index = new Map(all.map((s, i) => [s.name, i]));
  const instances = [];
  const walk = (sectionIndex, chain, depth) => {
    for (const entry of all[sectionIndex].lines) {
      const tokens = entry.text.split(/\s+/u);
      if (tokens[0] !== "1" || tokens.length < 15) continue;
      const reference = normalize(tokens.slice(14).join(" "));
      const link = { file: all[sectionIndex].name || "(main)", line: entry.line, text: entry.text };
      const child = index.get(reference);
      if (child !== undefined && !all[child].isPart && depth < 32) walk(child, [...chain, link], depth + 1);
      else instances.push({ reference, chain: [...chain, link] });
    }
  };
  walk(0, [], 0);
  return instances;
}

const flattened = new Map();
const checks = [];
const coverage = [];
const attributed = [];
for (const worst of report.worstNearLatticeInstances) {
  const set = worst.ref.replace("omr:", "");
  if (!flattened.has(set)) {
    const instances = flatten(fs.readFileSync(path.join(omrDir, `${set}.mpd`), "utf8"));
    const entry = manifest.models.find((m) => m.name === set);
    const model = JSON.parse(fs.readFileSync(path.join(bundleDir, entry.file), "utf8"));
    const baked = model.instances.part.map((p) => model.parts[p]);
    const sameStem = (a, b) => a.replace(/\.dat$/u, "").split("/").pop().split(" - ").pop() === b.replace("ldraw:", "");
    const mismatched = baked.filter((id, i) => !instances[i] || !sameStem(instances[i].reference, id)).length;
    checks.push({ set, bakedInstances: baked.length, walkedInstances: instances.length, partMismatches: mismatched });
    flattened.set(set, instances);
  }
  const instance = flattened.get(set)[worst.instance];
  const fractionalLines = instance.chain.filter((link) => {
    const tokens = link.text.split(/\s+/u).map(Number);
    return isFractional(tokens[2]) || isFractional(tokens[3]) || isFractional(tokens[4]);
  });
  attributed.push({
    ref: worst.ref,
    part: worst.part,
    distanceLdu: worst.distanceLdu,
    chain: instance.chain,
    linesWithFractionalPosition: fractionalLines,
  });
}
const hasFractionalLine = (chain) =>
  chain.some((link) => {
    const tokens = link.text.split(/\s+/u).map(Number);
    return isFractional(tokens[2]) || isFractional(tokens[3]) || isFractional(tokens[4]);
  });
for (const [ref, indices] of Object.entries(report.nearLatticeInstances)) {
  const set = ref.replace("omr:", "");
  if (!flattened.has(set)) flattened.set(set, flatten(fs.readFileSync(path.join(omrDir, `${set}.mpd`), "utf8")));
  const instances = flattened.get(set);
  const traced = indices.filter((i) => hasFractionalLine(instances[i].chain)).length;
  const sourceLines = new Set();
  for (const i of indices) for (const link of instances[i].chain) if (hasFractionalLine([link])) sourceLines.add(`${link.file}:${link.line}`);
  coverage.push({ ref, nearLatticeInstances: indices.length, tracedToFractionalSourceLine: traced, distinctFractionalSourceLines: sourceLines.size });
}
console.log(JSON.stringify({ walkChecks: checks, coverage, attributed }, null, 1));
