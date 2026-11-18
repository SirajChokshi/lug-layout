import { BundleIndex, FixtureModels } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { fixtureModel } from "./fixture-model.test-support.ts";

const repoRoot = new URL("../../../../", import.meta.url);
const fixtureList = new URL("tools/asset-pipeline/fixture-models.json", repoRoot);
const shippedManifest = new URL(
  "tools/asset-pipeline/dist/bundle/standard/manifest.json",
  repoRoot,
);
const generatedModelRoot = new URL("packages/test-fixtures/", repoRoot);
const PART_LINE = /^1\s/u;

async function json(url: URL): Promise<unknown> {
  return JSON.parse(await readFile(url, "utf8"));
}

it("loads every test fixture model fully baked from its own bundle, and the shipped bundle carries none of them", async () => {
  const { models } = decodedOrThrow(decode(FixtureModels, await json(fixtureList)), "fixtures");
  const index = decodedOrThrow(decode(BundleIndex, await json(shippedManifest)), "shipped");
  const shipped = new Set(index.models.map((entry) => entry.name));
  expect(models.map((model) => model.name)).toContain("road-baseplates");

  for (const model of models) {
    const source = await readFile(new URL(model.file, generatedModelRoot), "utf8");
    const placeable = await fixtureModel(model.name);
    expect({
      shipped: shipped.has(model.name),
      id: placeable.id,
      instances: placeable.parts.count,
    }).toEqual({
      shipped: false,
      id: `${model.origin}:${model.name}`,
      instances: source.split("\n").filter((line) => PART_LINE.test(line)).length,
    });
  }
}, 120_000);
