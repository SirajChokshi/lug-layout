import type { ModelRunningGear } from "@brr/catalog";
import { exactRationalEquals, parseExactRational } from "@brr/math";
import {
  unidentifiedRailReason,
  type ExactRationalText,
  type TrackPiece,
} from "@brr/schema/bundle";
import type { PlayTrack } from "../edit/track-drawing.ts";

export interface LayoutRails {
  readonly rails: Uint32Array;
  readonly pieceTitles: ReadonlyArray<string>;
  readonly notChecked: ReadonlyArray<string>;
}

const LDRAW_NAMESPACE = /^ldraw:/u;

function pieceName(piece: TrackPiece): string {
  return `${piece.part.replace(LDRAW_NAMESPACE, "")} (${piece.title})`;
}

function radiusText({ numerator, denominator }: ExactRationalText): string {
  return denominator === "1" ? numerator : `${numerator}/${denominator}`;
}

function laidPieces(track: PlayTrack): Uint8Array {
  const laid = new Uint8Array(track.pieces.length);
  for (let placement = 0; placement < track.layout.count; placement++) {
    laid[track.layout.piece(placement)] = 1;
  }
  return laid;
}

export function layoutRails(track: PlayTrack): LayoutRails {
  const laid = laidPieces(track);
  let railCount = 0;
  for (let index = 0; index < laid.length; index++) {
    if (laid[index] === 0) continue;
    for (const { rail } of track.pieces[index]?.connectors ?? []) {
      if (rail !== null) railCount = Math.max(railCount, rail + 1);
    }
  }
  const titleOfRail: Array<string | undefined> = Array.from({ length: railCount });
  const notChecked = new Set<string>();
  for (let index = 0; index < laid.length; index++) {
    const piece = track.pieces[index];
    if (laid[index] === 0 || !piece) continue;
    for (const connector of piece.connectors) {
      if (connector.rail === null) {
        notChecked.add(
          `Rail fit not checked on ${pieceName(piece)}: ${unidentifiedRailReason(connector)}.`,
        );
      } else {
        titleOfRail[connector.rail] ??= piece.title;
      }
    }
  }
  const rails = Uint32Array.from(titleOfRail.keys()).filter(
    (rail) => titleOfRail[rail] !== undefined,
  );
  return {
    rails,
    pieceTitles: Array.from(rails, (rail) => titleOfRail[rail] ?? ""),
    notChecked: [...notChecked],
  };
}

export function railFitRefusal(gear: ModelRunningGear, layout: LayoutRails): string | null {
  for (const [v, vehicle] of gear.vehicles.entries()) {
    for (const [w, wheelset] of vehicle.wheelsets.entries()) {
      if (!wheelset.seated) continue;
      const recorded = parseExactRational(wheelset.rollingRadius);
      for (let r = 0; r < layout.rails.length; r++) {
        const rail = layout.rails[r] ?? 0;
        const pieceTitle = layout.pieceTitles[r] ?? "";
        const onRail = wheelset.rollingRadiusOnRail[rail] ?? null;
        if (onRail !== null && exactRationalEquals(parseExactRational(onRail), recorded)) continue;
        const named = `Wheelset ${w + 1} of vehicle ${v + 1}`;
        const recordedText = `${radiusText(wheelset.rollingRadius)} LDU`;
        return onRail === null
          ? `${named} doesn't meet the rail of ${pieceTitle}; it rolls at ${recordedText} on the rail it was read on.`
          : `${named} rolls at ${radiusText(onRail)} LDU on the rail of ${pieceTitle}, not the ${recordedText} it was read at.`;
      }
    }
  }
  return null;
}
