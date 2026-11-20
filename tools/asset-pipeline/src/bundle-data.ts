import { LEVEL_CROSSING_FILE, PLAN_OUTLINES_FILE } from "./crossing/level-crossing.ts";
import { TRACK_CATALOG_FILE } from "./verify/facts.ts";

const PIPELINE_DIRECTORY = "tools/asset-pipeline";
const VERIFIED_FACTS_DIRECTORY = "docs/verified-facts";

export const FIXTURES_DIRECTORY = "packages/test-fixtures";

export const BUNDLE_DATA_FILES = {
  palette: `${PIPELINE_DIRECTORY}/palette.json`,
  fixtureModels: `${PIPELINE_DIRECTORY}/fixture-models.json`,
  primitiveConnectors: `${PIPELINE_DIRECTORY}/primitive-connectors.json`,
  inferredConnectors: `${PIPELINE_DIRECTORY}/inferred-connectors.json`,
  sectionVocabulary: `${PIPELINE_DIRECTORY}/section-vocabulary.json`,
  lock: `${PIPELINE_DIRECTORY}/ldraw.lock.json`,
  libraryBakePin: `${PIPELINE_DIRECTORY}/library-bake.json`,
  geometry: `${VERIFIED_FACTS_DIRECTORY}/geometry.json`,
  trackCatalog: `${VERIFIED_FACTS_DIRECTORY}/${TRACK_CATALOG_FILE}`,
  levelCrossing: `${VERIFIED_FACTS_DIRECTORY}/${LEVEL_CROSSING_FILE}`,
  planOutlines: `${VERIFIED_FACTS_DIRECTORY}/${PLAN_OUTLINES_FILE}`,
} as const;

export const BUNDLE_DATA_DIRECTORIES = {
  shadowPatches: `${PIPELINE_DIRECTORY}/shadow-patches`,
} as const;
