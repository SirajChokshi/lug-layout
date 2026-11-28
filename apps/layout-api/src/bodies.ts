import type {
  Account,
  ShareLinkSummary,
  VersionSummary,
  WorldSummary,
} from "@brr/schema/layout-api";
import type * as v from "valibot";
import type { AccountRecord } from "./accounts.ts";
import { isoTime } from "./http.ts";
import type { ShareLinkRecord } from "./share-links.ts";
import type { VersionRecord } from "./world-history.ts";
import type { WorldRecord } from "./world-record.ts";

export function accountBody(account: AccountRecord): v.InferInput<typeof Account> {
  return { id: account.id, email: account.email, createdAt: isoTime(account.createdAt) };
}

export function worldBody(world: WorldRecord): v.InferInput<typeof WorldSummary> {
  return {
    id: world.id,
    name: world.name,
    createdAt: isoTime(world.createdAt),
    updatedAt: isoTime(world.updatedAt),
    head: world.head,
  };
}

export function shareLinkBody(link: ShareLinkRecord): v.InferInput<typeof ShareLinkSummary> {
  return { id: link.id, role: link.role, createdAt: isoTime(link.createdAt) };
}

export function versionBody(version: VersionRecord): v.InferInput<typeof VersionSummary> {
  return {
    version: version.version,
    parent: version.parent,
    name: version.name,
    placements: version.placements,
    track: version.track,
    snapshot: version.snapshot,
    savedBy: version.savedBy,
    savedAt: isoTime(version.savedAt),
  };
}
