import { createHash } from "node:crypto";
const base = process.argv[2];
const sizes = [];
let ok = 0, bad = [];
for (const lod of ["standard", "low", "far"]) {
  const manifestResponse = await fetch(`${base}/bundle/${lod}/manifest.json`);
  const manifest = await manifestResponse.json();
  const files = [...manifest.studPrimitives, ...manifest.parts, ...manifest.models].map((e) => e.file);
  const queue = [...files];
  await Promise.all(Array.from({ length: 16 }, async () => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await fetch(`${base}/bundle/${lod}/${f}`);
      const bytes = new Uint8Array(await r.arrayBuffer());
      const digest = createHash("sha256").update(bytes).digest("hex");
      const named = f.match(/\.([0-9a-f]{16})\.(glb|json)$/)?.[1];
      if (named && digest.startsWith(named) && r.headers.get("cache-control") === "public, max-age=31536000, immutable") ok++;
      else bad.push(`${lod}/${f} ${digest} ${r.headers.get("cache-control")}`);
      sizes.push([`${lod}/${f}`, bytes.length, digest]);
    }
  }));
  console.log(lod, "bundleVersion", manifest.bundleVersion, "files", files.length, "manifest cache-control:", manifestResponse.headers.get("cache-control"), "inputs:", JSON.stringify(manifest.inputs));
}
console.log("fetched", sizes.length, "files; sha256 matches name hash and immutable header:", ok, "; failures:", bad.length, bad.slice(0, 5));
sizes.sort((a, b) => b[1] - a[1]);
console.log("largest 10:"); for (const [f, n, d] of sizes.slice(0, 10)) console.log(` ${f} ${n} ${d}`);
