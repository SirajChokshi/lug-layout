import { MILS_EDGE_RULES_FILE, TRACK_CATALOG_FILE } from "./verify/facts.ts";

const PIPELINE_DIRECTORY = "tools/asset-pipeline";
const VERIFIED_FACTS_DIRECTORY = "docs/verified-facts";

export const FIXTURES_DIRECTORY = "packages/test-fixtures";

export const BUNDLE_DATA_FILES = {
  palette: `${PIPELINE_DIRECTORY}/palette.json`,
  lock: `${PIPELINE_DIRECTORY}/ldraw.lock.json`,
  geometry: `${VERIFIED_FACTS_DIRECTORY}/geometry.json`,
  trackCatalog: `${VERIFIED_FACTS_DIRECTORY}/${TRACK_CATALOG_FILE}`,
  milsEdgeRules: `${VERIFIED_FACTS_DIRECTORY}/${MILS_EDGE_RULES_FILE}`,
} as const;
