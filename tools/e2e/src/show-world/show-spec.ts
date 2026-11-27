export interface ShowSpec {
  readonly name: string;
  readonly tableRows: number;
  readonly tablesPerRow: number;
  readonly tableWidthStuds: number;
  readonly tableDepthStuds: number;
  readonly aisleStuds: number;
  readonly models: number;
  readonly roadPlates: number;
  readonly trackPieces: number;
  readonly sidingsPerOval: number;
  readonly contributors: number;
}

export const SHOW_SCALE: ShowSpec = {
  name: "show",
  tableRows: 10,
  tablesPerRow: 12,
  tableWidthStuds: 192,
  tableDepthStuds: 96,
  aisleStuds: 128,
  models: 250,
  roadPlates: 400,
  trackPieces: 2500,
  sidingsPerOval: 3,
  contributors: 30,
};

export const SMOKE_SCALE: ShowSpec = {
  name: "smoke",
  tableRows: 1,
  tablesPerRow: 4,
  tableWidthStuds: 192,
  tableDepthStuds: 96,
  aisleStuds: 128,
  models: 3,
  roadPlates: 6,
  trackPieces: 90,
  sidingsPerOval: 1,
  contributors: 2,
};

const SCALES: ReadonlyArray<ShowSpec> = [SHOW_SCALE, SMOKE_SCALE];

export function showSpecNamed(name: string): ShowSpec {
  const spec = SCALES.find((scale) => scale.name === name);
  if (!spec) {
    throw new Error(
      `there is no show scale ${name}; choose ${SCALES.map((scale) => scale.name).join(" or ")}`,
    );
  }
  return spec;
}
