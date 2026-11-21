import { expect, it } from "vitest";
import { ConnectorRecords } from "./connector-records.ts";

const PATHS = {
  connectivity: "standard/connectivity-index.json",
  connectors: "standard/connector-index.json",
};
const SOURCE = { kind: "github-mirror", repo: "kulits/ldraw-parts", commit: "c0ffee", root: "" };
const PART = "ldraw:3001";

function emptyIndex(pkg: "connectivity" | "connectors") {
  return { package: pkg, licenses: [], attribution: [], source: SOURCE, parts: { [PART]: null } };
}

it("reads the package indexes again after a failed read instead of replaying the failure", async () => {
  let unreachable = true;
  const asked: string[] = [];
  const records = new ConnectorRecords(
    async (path) => {
      asked.push(path);
      if (unreachable) throw new TypeError(`Failed to fetch ${path}`);
      return emptyIndex(path === PATHS.connectivity ? "connectivity" : "connectors");
    },
    PATHS,
    null,
  );

  const failed = await records.read(PART).then(
    () => "read",
    (error: unknown) => String(error),
  );
  unreachable = false;
  const retried = await records.read(PART);

  expect({ failed, retried, asked: asked.toSorted() }).toEqual({
    failed: expect.stringContaining("Failed to fetch"),
    retried: { kind: "loaded", connectors: expect.objectContaining({ count: 0 }) },
    asked: [PATHS.connectivity, PATHS.connectivity, PATHS.connectors, PATHS.connectors].toSorted(),
  });
});
