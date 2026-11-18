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
    private readonly read: ReadJson,
    private readonly paths: ConnectorIndexPaths,
  ) {}

  private loadIndexes(): Promise<readonly [ConnectorIndexFile, ConnectorIndexFile]> {
    this.indexes ??= Promise.all([
      this.index(this.paths.connectivity),
      this.index(this.paths.connectors),
    ]);
    return this.indexes;
  }

  private async index(path: string): Promise<ConnectorIndexFile> {
    return decodedOrThrow(decode(ConnectorIndexFile, await this.read(path)), path);
  }

  private async record(indexPath: string, file: string): Promise<ConnectorRecordFile> {
    const path = `${directoryOf(indexPath)}${file}`;
    return decodedOrThrow(decode(ConnectorRecordFile, await this.read(path)), path);
  }

  async connectivityAttribution(): Promise<PackageAttribution> {
    const [{ licenses, attribution }] = await this.loadIndexes();
    return { licenses, attribution };
  }

  async load(partId: string): Promise<PartConnectors | null> {
    const [connectivity, connectors] = await this.loadIndexes();
    const tier1 = connectivity.parts[partId];
    const rest = connectors.parts[partId];
    if (tier1 === undefined || rest === undefined) return null;
    const records: Promise<ConnectorRecordFile>[] = [];
    if (tier1 !== null) records.push(this.record(this.paths.connectivity, tier1.file));
    if (rest !== null) records.push(this.record(this.paths.connectors, rest.file));
    return partConnectors(await Promise.all(records));
  }
}
