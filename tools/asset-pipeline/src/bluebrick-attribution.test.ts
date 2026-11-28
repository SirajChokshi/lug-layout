import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { renderBlueBrickAttribution } from "./bluebrick-attribution.ts";
import { FIXTURES_DIRECTORY } from "./bundle-data.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

it("the committed attribution lists every BlueBrick file as its sources record it", async () => {
  const attribution = await readFile(join(repoRoot, FIXTURES_DIRECTORY, "ATTRIBUTION.md"), "utf8");
  expect(attribution.endsWith(await renderBlueBrickAttribution(repoRoot))).toBe(true);
});

it("a file that no longer matches its published bytes, or isn't listed, is refused", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brr-bluebrick-"));
  try {
    const published = "<Map />";
    const sources = {
      files: [
        {
          file: "published.bbm",
          sha256: createHash("sha256").update(published).digest("hex"),
          author: "a",
          license: "MIT",
          licenseText: null,
          source: "https://example.org/published.bbm",
        },
      ],
    };
    await writeFile(join(directory, "sources.json"), JSON.stringify(sources));
    await writeFile(join(directory, "published.bbm"), published);
    await expect(renderBlueBrickAttribution(directory, ".")).resolves.toContain("published.bbm");

    await writeFile(join(directory, "published.bbm"), "<Map></Map>");
    await expect(renderBlueBrickAttribution(directory, ".")).rejects.toThrow(
      `not the ${sources.files[0]?.sha256 ?? ""}`,
    );

    await writeFile(join(directory, "published.bbm"), published);
    await writeFile(join(directory, "stray.bbm"), published);
    await expect(renderBlueBrickAttribution(directory, ".")).rejects.toThrow(
      "doesn't list stray.bbm",
    );

    await rm(join(directory, "stray.bbm"));
    await writeFile(join(directory, "stray.bbb"), "<Budget />");
    await expect(renderBlueBrickAttribution(directory, ".")).rejects.toThrow(
      "doesn't list stray.bbb",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
