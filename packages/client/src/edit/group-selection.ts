import type { GroupMembers, GroupTable, GroupTagged, PlacementRef } from "@brr/domain";
import type { PlacedModel } from "./placed-chunks.ts";
import { sameMember, type SelectionGrouping, type SelectionMember } from "./selection.ts";
import type { TrackDrawing } from "./track-drawing.ts";

export interface GroupSelectionHost {
  table(): GroupTable;
  models(): ReadonlyArray<PlacedModel>;
  track(): TrackDrawing | null;
}

export class GroupSelection {
  constructor(private readonly host: GroupSelectionHost) {}

  private groupOf(member: SelectionMember): number | null {
    switch (member.kind) {
      case "model":
        return member.model.handle.group;
      case "track":
        return this.host.track()?.pieceGroup(member.placement) ?? null;
      case "train":
        return null;
      default: {
        const unhandled: never = member;
        throw new Error(`unhandled selection member ${String(unhandled)}`);
      }
    }
  }

  outermostOf(member: SelectionMember): number | null {
    const group = this.groupOf(member);
    return group === null ? null : this.outermost(group);
  }

  withGroups(chosen: ReadonlyArray<SelectionMember>): ReadonlyArray<SelectionMember> {
    const outermost = new Set<number>();
    for (const member of chosen) {
      const group = this.outermostOf(member);
      if (group !== null) outermost.add(group);
    }
    if (outermost.size === 0) return chosen;
    const mates = this.membersOf(outermost).filter(
      (member) => !chosen.some((picked) => sameMember(picked, member)),
    );
    return [...mates, ...chosen];
  }

  tagged(members: ReadonlyArray<SelectionMember>): GroupMembers<PlacementRef> {
    const placements: GroupTagged<PlacementRef>[] = [];
    const pieces: GroupTagged<number>[] = [];
    const track = this.host.track();
    for (const member of members) {
      if (member.kind === "model") {
        const { handle, placement } = member.model;
        placements.push({ member: placement, layer: handle.layer, group: handle.group });
      } else if (member.kind === "track" && track) {
        const { placement } = member;
        pieces.push({
          member: placement,
          layer: track.pieceLayer(placement),
          group: track.pieceGroup(placement),
        });
      }
    }
    return { placements, pieces };
  }

  summary(members: ReadonlyArray<SelectionMember>): SelectionGrouping {
    const table = this.host.table();
    const outermost = new Set<number>();
    let loose = 0;
    for (const member of members) {
      const group = this.outermostOf(member);
      if (group === null) loose++;
      else outermost.add(group);
    }
    const groups = [...outermost]
      .toSorted((a, b) => a - b)
      .map((id) => table.group(id)?.name ?? "");
    return { groups, loose };
  }

  private outermost(group: number): number {
    const outermost = this.host.table().outermost(group);
    if (outermost === undefined) throw new Error(`group ${group} isn't in the group table`);
    return outermost;
  }

  private membersOf(outermost: ReadonlySet<number>): ReadonlyArray<SelectionMember> {
    const inside = (group: number | null): boolean =>
      group !== null && outermost.has(this.outermost(group));
    const members: SelectionMember[] = [];
    for (const model of this.host.models()) {
      if (inside(model.handle.group)) members.push({ kind: "model", model });
    }
    const track = this.host.track();
    if (!track) return members;
    for (let placement = 0; placement < track.pieceCount; placement++) {
      if (inside(track.pieceGroup(placement))) members.push({ kind: "track", placement });
    }
    return members;
  }
}
