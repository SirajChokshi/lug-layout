export interface ConnectorColumns {
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
  readonly unreadable: ReadonlyArray<string>;
}
