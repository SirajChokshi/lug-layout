import { ConnectorRecords, type ConnectorLoad } from "@brr/catalog/connector-records";
import {
  LIBRARY_CONNECTORS_INDEX_FILE,
  LibraryConnectorsIndex,
  type LibraryConnectorsIndexRef,
} from "@brr/schema/bundle";
import { decode, issueText } from "@brr/schema/decode";
import { sameSource, type FetchFunction, type MirrorSource } from "./ldraw-mirror.ts";
import type { PartConnectorSource } from "./model-import.ts";
import { VerifiedFiles, type IByteCache, type RecordStats } from "./verified-files.ts";

const SHORT_SHA256 = 12;

export interface LibraryConnectorOptions {
  readonly source: MirrorSource;
  readonly sectionVocabulary: string;
}

type Opened =
  | {
      readonly kind: "open";
      readonly index: LibraryConnectorsIndex;
      readonly records: ConnectorRecords;
    }
  | { readonly kind: "unreadable"; readonly reason: string };

function json(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(bytes));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refused(reason: string): ConnectorLoad {
  return { kind: "refused", reason };
}

function described(source: MirrorSource): string {
  return `${source.repo}@${source.commit}/${source.root}`;
}

export class LibraryConnectorStore {
  readonly key: string;
  private readonly files: VerifiedFiles;
  private opened: Promise<Opened> | null = null;

  constructor(
    baseUrl: string,
    private readonly pin: LibraryConnectorsIndexRef,
    fetchUrl: FetchFunction,
    cache: IByteCache,
  ) {
    this.key = pin.sha256;
    this.files = new VerifiedFiles(baseUrl, fetchUrl, cache);
  }

  source(options: LibraryConnectorOptions): PartConnectorSource {
    return { read: (partId) => this.read(partId, options) };
  }

  stats(): RecordStats {
    return this.files.stats();
  }

  private get label(): string {
    return `the pinned library's connector records (index ${this.pin.sha256.slice(0, SHORT_SHA256)})`;
  }

  private async read(partId: string, options: LibraryConnectorOptions): Promise<ConnectorLoad> {
    const loading = (this.opened ??= this.open().catch((error: unknown): Opened => ({
      kind: "unreadable",
      reason: messageOf(error),
    })));
    const opened = await loading;
    if (opened.kind === "unreadable") {
      if (this.opened === loading) this.opened = null;
      return refused(`${this.label} can't be read: ${opened.reason}`);
    }
    const { index, records } = opened;
    if (!sameSource(index.ldraw, options.source)) {
      return refused(
        `${this.label} were computed from ${described(index.ldraw)}, not the import's ${described(options.source)}`,
      );
    }
    if (index.sectionVocabulary !== options.sectionVocabulary) {
      return refused(
        `${this.label} were inferred with section vocabulary ${index.sectionVocabulary}, not ${options.sectionVocabulary}`,
      );
    }
    try {
      return await records.read(partId);
    } catch (error) {
      if (this.opened === loading) this.opened = null;
      return refused(`its record in ${this.label} can't be read: ${messageOf(error)}`);
    }
  }

  private async open(): Promise<Opened> {
    if (this.pin.file !== LIBRARY_CONNECTORS_INDEX_FILE) {
      return { kind: "unreadable", reason: `the pin names ${this.pin.file}` };
    }
    const bytes = await this.files.pinned(this.pin.file, this.pin.sha256);
    if (bytes === null) {
      return { kind: "unreadable", reason: "the served index differs from its pinned SHA-256" };
    }
    const decoded = decode(LibraryConnectorsIndex, json(bytes), LIBRARY_CONNECTORS_INDEX_FILE);
    if (!decoded.ok) return { kind: "unreadable", reason: issueText(decoded.issues) };
    const index = decoded.value;
    const records = new ConnectorRecords(
      async (path) => json(await this.files.addressed(path)),
      { connectivity: index.connectivity.file, connectors: index.connectors.file },
      index.sectionVocabulary,
    );
    return { kind: "open", index, records };
  }
}

export class BundleThenLibraryConnectors implements PartConnectorSource {
  constructor(
    private readonly bundle: PartConnectorSource,
    private readonly library: PartConnectorSource,
  ) {}

  async read(partId: string): Promise<ConnectorLoad> {
    const loaded = await this.bundle.read(partId);
    return loaded.kind === "unlisted" ? this.library.read(partId) : loaded;
  }
}
