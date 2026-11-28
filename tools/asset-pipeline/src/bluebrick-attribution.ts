import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";

export const BLUEBRICK_FIXTURES_DIRECTORY = join("packages", "test-fixtures", "bluebrick");
const SOURCES_FILE = "sources.json";
const BLUEBRICK_EXTENSIONS = [".bbm", ".bbb"];

const BlueBrickSources = v.strictObject({
  files: v.array(
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
  const { files } = v.parse(
    BlueBrickSources,
    JSON.parse(await readFile(join(root, SOURCES_FILE), "utf8")),
  );
  const listed = new Set(files.map((entry) => entry.file));
  const unlisted = (await readdir(root)).filter(
    (name) =>
      BLUEBRICK_EXTENSIONS.some((extension) => name.endsWith(extension)) && !listed.has(name),
  );
  if (unlisted.length > 0) {
    throw new Error(`${join(directory, SOURCES_FILE)} doesn't list ${unlisted.join(", ")}`);
  }
  const rows: string[] = [];
  for (const entry of files) {
    const sha256 = createHash("sha256")
      .update(await readFile(join(root, entry.file)))
      .digest("hex");
    if (sha256 !== entry.sha256) {
      throw new Error(
        `${join(directory, entry.file)} has SHA-256 ${sha256}, not the ${entry.sha256} its source published`,
      );
    }
    if (entry.licenseText !== null) await readFile(join(root, entry.licenseText));
    const licenseText =
      entry.licenseText === null ? "" : `\`${join(directory, entry.licenseText)}\``;
    rows.push(
      `| \`${join(directory, entry.file)}\` | ${entry.author} | ${entry.license} | ${licenseText} | ${entry.source} | \`${entry.sha256}\` |`,
    );
  }
  return [
    "## BlueBrick maps and budgets",
    "",
    `BlueBrick \`.bbm\` layouts and \`.bbb\` budgets read by the BlueBrick readers' tests, listed in \`${join(directory, SOURCES_FILE)}\`. Each published file is committed byte for byte as its source holds it at the commit linked, under the licence named, with the full licence text beside it. BlueBrick is © Alban Nanty and free software under GPL-3.0; these files were saved with it and aren't part of it.`,
    "",
    "| File | Author | License | License text | Source | SHA-256 |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}
