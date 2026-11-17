import { PaletteIndex, TRACK_ITEM_ID, type EditorSnapshot } from "@brr/client";
import { useMemo } from "react";

function trackTerms(track: EditorSnapshot["track"]): ReadonlyArray<string> {
  return (track?.bom ?? []).flatMap((line) => [line.piece.replace(/^[a-z]+:/u, ""), line.title]);
}

export function usePaletteIndex(
  catalog: EditorSnapshot["catalog"],
  track: EditorSnapshot["track"],
): PaletteIndex {
  const trackKey = trackTerms(track).join("\n");
  return useMemo(
    () =>
      new PaletteIndex(catalog, [
        { entryKey: TRACK_ITEM_ID, terms: trackKey === "" ? [] : trackKey.split("\n") },
      ]),
    [catalog, trackKey],
  );
}
