import {
  ConnectorIndexFile,
  ConnectorRecordFile,
  type UnreadableConnector,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";

export interface PartConnectors {
  readonly count: number;
  readonly gender: Uint8Array;
  readonly source: Uint8Array;
  readonly status: Uint8Array;
  readonly caps: Uint8Array;
  readonly slide: Uint8Array;
  readonly group: ReadonlyArray<string>;
  readonly origin: Int32Array;
  readonly axis: Int8Array;
  readonly sectionStart: Uint32Array;
  readonly sectionCount: Uint32Array;
  readonly sectionCode: Uint8Array;
  readonly sectionSize: Float64Array;
  readonly sectionLength: Float64Array;
  readonly piece: Uint16Array;
  readonly freeFace: Uint32Array;
  readonly freeOrigin: Float64Array;
  readonly freeAxis: Float64Array;
  readonly unreadable: ReadonlyArray<UnreadableConnector>;
}

export interface ConnectorIndexPaths {
  readonly connectivity: string;
  readonly connectors: string;
}

export interface PackageAttribution {
  readonly licenses: ReadonlyArray<string>;
  readonly attribution: ReadonlyArray<string>;
}

export type ReadJson = (path: string) => Promise<unknown>;

export type ConnectorLoad =
  | { readonly kind: "loaded"; readonly connectors: PartConnectors }
  | { readonly kind: "unlisted" }
  | { readonly kind: "refused"; readonly reason: string };

const VECTOR_FLOATS = 3;

export function partConnectors(records: ReadonlyArray<ConnectorRecordFile>): PartConnectors {
  const faces = records.reduce((sum, record) => sum + record.faces.gender.length, 0);
  const sections = records.reduce((sum, record) => sum + record.faces.sectionCode.length, 0);
  const free = records.reduce((sum, record) => sum + record.free.face.length, 0);
  const out = {
    count: faces,
    gender: new Uint8Array(faces),
    source: new Uint8Array(faces),
    status: new Uint8Array(faces),
    caps: new Uint8Array(faces),
    slide: new Uint8Array(faces),
    group: [] as string[],
    origin: new Int32Array(faces * VECTOR_FLOATS),
    axis: new Int8Array(faces),
    sectionStart: new Uint32Array(faces),
    sectionCount: new Uint32Array(faces),
    sectionCode: new Uint8Array(sections),
    sectionSize: new Float64Array(sections),
    sectionLength: new Float64Array(sections),
    piece: new Uint16Array(faces),
    freeFace: new Uint32Array(free),
    freeOrigin: new Float64Array(free * VECTOR_FLOATS),
    freeAxis: new Float64Array(free * VECTOR_FLOATS),
    unreadable: records.flatMap((record) => record.unreadable),
  };
  let face = 0;
  let section = 0;
  let freeAt = 0;
  for (const { faces: columns, free: loose } of records) {
    out.gender.set(columns.gender, face);
    out.source.set(columns.source, face);
    out.status.set(columns.status, face);
    out.caps.set(columns.caps, face);
    out.slide.set(columns.slide.map(Number), face);
    out.group.push(...columns.group);
    out.origin.set(columns.origin, face * VECTOR_FLOATS);
    out.axis.set(columns.axis, face);
    out.sectionStart.set(
      columns.sectionStart.map((start) => start + section),
      face,
    );
    out.sectionCount.set(columns.sectionCount, face);
    out.sectionCode.set(columns.sectionCode, section);
    out.sectionSize.set(columns.sectionSize, section);
    out.sectionLength.set(columns.sectionLength, section);
    out.piece.set(columns.piece, face);
    out.freeFace.set(
      loose.face.map((index) => index + face),
      freeAt,
    );
    out.freeOrigin.set(loose.origin, freeAt * VECTOR_FLOATS);
    out.freeAxis.set(loose.axis, freeAt * VECTOR_FLOATS);
    face += columns.gender.length;
    section += columns.sectionCode.length;
    freeAt += loose.face.length;
  }
  return out;
}

function directoryOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/") + 1);
}

export class ConnectorRecords {
  private indexes: Promise<readonly [ConnectorIndexFile, ConnectorIndexFile]> | null = null;

  constructor(
    private readonly readJson: ReadJson,
    private readonly paths: ConnectorIndexPaths,
    private readonly sectionVocabulary: string | null,
  ) {}

  private loadIndexes(): Promise<readonly [ConnectorIndexFile, ConnectorIndexFile]> {
    this.indexes ??= Promise.all([
      this.index(this.paths.connectivity),
      this.index(this.paths.connectors),
    ]);
    return this.indexes;
  }

  private async index(path: string): Promise<ConnectorIndexFile> {
    return decodedOrThrow(decode(ConnectorIndexFile, await this.readJson(path)), path);
  }

  private async record(indexPath: string, file: string): Promise<ConnectorRecordFile> {
    const path = `${directoryOf(indexPath)}${file}`;
    return decodedOrThrow(decode(ConnectorRecordFile, await this.readJson(path)), path);
  }

  async connectivityAttribution(): Promise<PackageAttribution> {
    const [{ licenses, attribution }] = await this.loadIndexes();
    return { licenses, attribution };
  }

  private vocabularyMismatch(found: string | undefined, what: string): string | null {
    if (this.sectionVocabulary === null || found === this.sectionVocabulary) return null;
    return `${what} was inferred with section vocabulary ${found ?? "(none)"}, not ${this.sectionVocabulary}`;
  }

  async read(partId: string): Promise<ConnectorLoad> {
    const [connectivity, connectors] = await this.loadIndexes();
    const tier1 = connectivity.parts[partId];
    const rest = connectors.parts[partId];
    if (tier1 === undefined || rest === undefined) return { kind: "unlisted" };
    const indexMismatch = this.vocabularyMismatch(
      connectors.sectionVocabulary,
      this.paths.connectors,
    );
    if (indexMismatch !== null) return { kind: "refused", reason: indexMismatch };
    const records: ConnectorRecordFile[] = [];
    if (tier1 !== null) records.push(await this.record(this.paths.connectivity, tier1.file));
    if (rest !== null) {
      const record = await this.record(this.paths.connectors, rest.file);
      const mismatch = this.vocabularyMismatch(
        record.sectionVocabulary,
        `${partId}'s connector record`,
      );
      if (mismatch !== null) return { kind: "refused", reason: mismatch };
      records.push(record);
    }
    return { kind: "loaded", connectors: partConnectors(records) };
  }

  async load(partId: string): Promise<PartConnectors | null> {
    const loaded = await this.read(partId);
    switch (loaded.kind) {
      case "loaded":
        return loaded.connectors;
      case "unlisted":
        return null;
      case "refused":
        throw new Error(loaded.reason);
      default: {
        const unhandled: never = loaded;
        throw new Error(`unhandled connector load ${String(unhandled)}`);
      }
    }
  }
}
