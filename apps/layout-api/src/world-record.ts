import type { RecordId } from "@brr/schema/layout-api";

export interface WorldRecord {
  readonly id: RecordId;
  readonly ownerId: RecordId;
  readonly name: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly head: number | null;
}
