import {
  canonicalJson,
  noteShards,
  shardName,
  type NoteRecordV2,
  type NoteShardV2,
  type SuperChunk,
} from "@brr/schema/world";

export interface NoteShardChange {
  readonly put: ReadonlyArray<NoteShardV2>;
  readonly drop: ReadonlyArray<SuperChunk>;
}

interface SavedShard {
  readonly superChunk: SuperChunk;
  readonly text: string;
}

export class SavedNoteShards {
  private saved = new Map<string, SavedShard>();

  reset(shards: ReadonlyArray<NoteShardV2>): void {
    this.saved = new Map(
      shards.map((shard) => [
        shardName(shard.superChunk),
        { superChunk: shard.superChunk, text: canonicalJson(shard) },
      ]),
    );
  }

  change(notes: ReadonlyArray<NoteRecordV2>): NoteShardChange {
    const current = new Set<string>();
    const put: NoteShardV2[] = [];
    for (const shard of noteShards(notes)) {
      const name = shardName(shard.superChunk);
      current.add(name);
      if (this.saved.get(name)?.text !== canonicalJson(shard)) put.push(shard);
    }
    const drop: SuperChunk[] = [];
    for (const [name, shard] of this.saved) {
      if (!current.has(name)) drop.push(shard.superChunk);
    }
    return { put, drop };
  }

  accept(change: NoteShardChange): void {
    for (const superChunk of change.drop) this.saved.delete(shardName(superChunk));
    for (const shard of change.put) {
      this.saved.set(shardName(shard.superChunk), {
        superChunk: shard.superChunk,
        text: canonicalJson(shard),
      });
    }
  }
}
