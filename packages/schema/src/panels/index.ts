import * as v from "valibot";

export const PANEL_LAYOUT_VERSION = 1;

export const PanelLayout = v.strictObject({
  version: v.literal(PANEL_LAYOUT_VERSION),
  library: v.boolean(),
  stats: v.boolean(),
});
export type PanelLayout = v.InferOutput<typeof PanelLayout>;
