import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

export const BLUEBRICK_FIXTURES_DIRECTORY = join("packages", "test-fixtures", "bluebrick");
const SOURCES_FILE = "sources.json";
const MAP_EXTENSION = ".bbm";

const BlueBrickSources = v.strictObject({
  maps: v.array(
    v.strictObject({
      file: v.string(),
      sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u)),
      author: v.string(),
      license: v.string(),
      licenseText: v.nullable(v.string()),
      source: v.string(),
    }),
  ),
});

export async function renderBlueBrickAttribution(
  repoRoot: string,
  directory = BLUEBRICK_FIXTURES_DIRECTORY,
): Promise<string> {
  const root = join(repoRoot, directory);
  const { maps } = v.parse(
    BlueBrickSources,
    JSON.parse(await readFile(join(root, SOURCES_FILE), "utf8")),
  );
  const listed = new Set(maps.map((map) => map.file));
  const unlisted = (await readdir(root)).filter(
    (name) => name.endsWith(MAP_EXTENSION) && !listed.has(name),
  );
  if (unlisted.length > 0) {
    throw new Error(`${join(directory, SOURCES_FILE)} doesn't list ${unlisted.join(", ")}`);
  }
  const rows: string[] = [];
  for (const map of maps) {
    const sha256 = createHash("sha256")
      .update(await readFile(join(root, map.file)))
      .digest("hex");
    if (sha256 !== map.sha256) {
      throw new Error(
        `${join(directory, map.file)} has SHA-256 ${sha256}, not the ${map.sha256} its source published`,
      );
    }
    if (map.licenseText !== null) await readFile(join(root, map.licenseText));
    const licenseText = map.licenseText === null ? "" : `\`${join(directory, map.licenseText)}\``;
    rows.push(
      `| \`${join(directory, map.file)}\` | ${map.author} | ${map.license} | ${licenseText} | ${map.source} | \`${map.sha256}\` |`,
    );
  }
  return [
    "## BlueBrick maps",
    "",
    `BlueBrick \`.bbm\` layouts read by the \`.bbm\` reader's tests, listed in \`${join(directory, SOURCES_FILE)}\`. Each published map is committed byte for byte as its source holds it at the commit linked, under the licence named, with the full licence text beside it. BlueBrick is © Alban Nanty and free software under GPL-3.0; these maps were saved with it and aren't part of it.`,
    "",
    "| File | Author | License | License text | Source | SHA-256 |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
