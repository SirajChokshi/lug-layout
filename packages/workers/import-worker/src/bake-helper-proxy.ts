import type { BakeOutcome, BakeRequest, IBakeHelper, LibraryFiles, RecordFiles } from "@brr/import";
import { BAKE_HELPER_PROTOCOL, RpcEndpoint } from "@brr/rpc";
import type {
  BakeHelperReply,
  BakeHelperRequest,
  LibraryDelta,
  RecordDelta,
} from "./bake-helper-protocol.ts";

export class BakeHelperProxy {
  private readonly endpoint: RpcEndpoint<BakeHelperRequest, BakeHelperReply>;
  private readonly broken: Promise<never>;
  private libraryKey = "";
  private readonly sentFiles = new Set<string>();
  private readonly sentAbsent = new Set<string>();
  private recordKey = "";
  private readonly sentRecords = new Set<string>();

  constructor(port: MessagePort) {
    this.endpoint = new RpcEndpoint(port, BAKE_HELPER_PROTOCOL);
    this.broken = new Promise((_, reject) => {
      port.addEventListener("messageerror", () =>
        reject(new Error("a bake helper's reply could not be read")),
      );
      port.addEventListener("close", () => reject(new Error("a bake helper's port closed")));
    });
    this.broken.catch(() => undefined);
    port.start();
  }

  helper(compilerUrl: string): IBakeHelper {
    return {
      bake: (request, library, records) => this.bake(compilerUrl, request, library, records),
    };
  }

  private async bake(
    compilerUrl: string,
    request: BakeRequest,
    library: LibraryFiles,
    records: RecordFiles | null,
  ): Promise<BakeOutcome> {
    const reply = await Promise.race([
      this.endpoint.request({
        compilerUrl,
        request,
        library: this.delta(library),
        records: records === null ? null : this.recordDelta(records),
      }),
      this.broken,
    ]);
    switch (reply.kind) {
      case "settled":
        return reply.outcome;
      case "threw":
        throw new Error(reply.message);
      default: {
        const unhandled: never = reply;
        throw new Error(`unhandled bake helper reply ${String(unhandled)}`);
      }
    }
  }

  private recordDelta(records: RecordFiles): RecordDelta {
    if (records.key !== this.recordKey) {
      this.recordKey = records.key;
      this.sentRecords.clear();
    }
    const files: Array<readonly [string, Uint8Array]> = [];
    for (const [reference, bytes] of records.files) {
      if (!this.sentRecords.has(reference)) files.push([reference, bytes]);
    }
    const references = [...records.files.keys()];
    this.sentRecords.clear();
    for (const reference of references) this.sentRecords.add(reference);
    return { key: records.key, files, references };
  }

  private delta(library: LibraryFiles): LibraryDelta {
    if (library.key !== this.libraryKey) {
      this.libraryKey = library.key;
      this.sentFiles.clear();
      this.sentAbsent.clear();
    }
    const files: Array<readonly [string, string]> = [];
    for (const [path, text] of library.files) {
      if (this.sentFiles.has(path)) continue;
      this.sentFiles.add(path);
      files.push([path, text]);
    }
    const absent = [...library.absent].filter((path) => !this.sentAbsent.has(path));
    for (const path of absent) this.sentAbsent.add(path);
    return { key: library.key, files, absent };
  }
}
