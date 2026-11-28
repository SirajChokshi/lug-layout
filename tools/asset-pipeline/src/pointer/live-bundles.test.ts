import { BundleCompiler, BundleIndex, BundleLod, BundleModelEntry } from "@brr/schema/bundle";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { sha256Hex } from "../r2.ts";
import { liveBundleLibraryBakeIndexes } from "./live-bundles.ts";
import { partBundlePointer } from "./part-bundle-pointer.ts";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const encoder = new TextEncoder();

function manifestFile(version: string): string {
  return `manifest.${sha256Hex(version).slice(0, 16)}.json`;
}

function libraryBakeIndex(version: string) {
  return { file: "library-bake.json", sha256: sha256Hex(`library-bake ${version}`) };
}

async function fallbackNaming(version: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "live-bundles-"));
  roots.push(root);
  const path = join(root, "bundle-fallback.json");
  await writeFile(path, JSON.stringify({ manifest_file: manifestFile(version) }));
  return path;
}

it("reads the library-bake index every LOD manifest of the current, previous and committed fallback bundles names, skips bundles that name none, and refuses without the pointer or a manifest", async () => {
  const objects = new Map<string, Uint8Array>();
  const read = async (key: string) => objects.get(key);
  const fallback = await fallbackNaming("fallback");
  await expect(liveBundleLibraryBakeIndexes(read, fallback)).rejects.toThrow(
    "current/latest.json is not served",
  );
  const compilers: Record<string, unknown> = {
    fallback: { file: "brick-compile", libraryBake: libraryBakeIndex("old") },
    previous: { file: "brick-compile" },
    current: { file: "brick-compile", libraryBake: libraryBakeIndex("new") },
  };
  for (const [version, compiler] of Object.entries(compilers)) {
    for (const lod of BundleLod.options) {
      objects.set(`${lod}/${manifestFile(version)}`, encoder.encode(JSON.stringify({ compiler })));
    }
  }
  const pointer = partBundlePointer(fallback);
  objects.set(
    pointer.key,
    pointer.encode({ current: manifestFile("current"), previous: manifestFile("previous") }),
  );

  expect(await liveBundleLibraryBakeIndexes(read, fallback)).toEqual([
    libraryBakeIndex("new"),
    libraryBakeIndex("old"),
  ]);

  objects.delete(`far/${manifestFile("fallback")}`);
  await expect(liveBundleLibraryBakeIndexes(read, fallback)).rejects.toThrow(
    `far/${manifestFile("fallback")} is not served`,
  );
});

it("the bundle manifest's fields, its model entries' and its compiler's are exactly these, so a field naming a file the bundle walk can't reach, another publication's index or a name that isn't content-addressed, can't land until that publication's prune retains what the live bundle manifests name", () => {
  expect({
    manifest: Object.keys(BundleIndex.entries),
    model: Object.keys(BundleModelEntry.entries),
    compiler: Object.keys(BundleCompiler.entries),
  }).toEqual({
    manifest: [
      "bundleVersion",
      "unit",
      "upAxis",
      "lod",
      "source",
      "studPrimitives",
      "colors",
      "models",
      "catalogParts",
      "modified",
      "disclaimer",
      "inputs",
      "trackCatalog",
      "trackShapes",
      "tablePlane",
      "levelCrossing",
      "compiler",
      "connectors",
      "connectivity",
      "crosswalk",
      "connectorPacks",
      "partTable",
      "creditTable",
      "thumbnails",
      "rollingDiagnostics",
      "libraryParts",
    ],
    model: [
      "name",
      "file",
      "origin",
      "set",
      "role",
      "source",
      "authors",
      "licenses",
      "sections",
      "inlinePartsResolvedToOfficial",
      "instances",
      "lattice",
      "vehicles",
      "sha256",
      "cover",
      "notDrawn",
      "errata",
      "farMesh",
      "glyph",
    ],
    compiler: [
      "file",
      "unofficialAllowlist",
      "vehicles",
      "primitives",
      "sectionVocabulary",
      "cavityProbe",
      "libraryBake",
      "libraryConnectors",
      "shadowLibrary",
    ],
  });
});
