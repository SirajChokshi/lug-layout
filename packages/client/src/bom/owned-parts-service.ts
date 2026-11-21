import { readOwnedPartsCsv, type OwnedParts } from "@brr/domain";
import { issueText } from "@brr/schema/decode";
import { OWNED_PARTS_FILE_VERSION } from "@brr/schema/owned-parts";
import { OWNED_PARTS_REPOSITORY, type IOwnedPartsRepository } from "@brr/storage";
import { inject, injectable } from "inversify";

export interface OwnedPartsView {
  readonly loaded: boolean;
  readonly owned: OwnedParts | null;
  readonly problem: string | null;
}

export interface TextFile {
  readonly name: string;
  text(): Promise<string>;
}

export interface IOwnedParts {
  subscribe(listener: () => void): () => void;
  view(): OwnedPartsView;
  load(): Promise<void>;
  importFile(file: TextFile): Promise<void>;
  clear(): Promise<void>;
}

const NOT_LOADED: OwnedPartsView = { loaded: false, owned: null, problem: null };

function problemText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

@injectable()
export class OwnedPartsService implements IOwnedParts {
  private readonly listeners = new Set<() => void>();
  private state = NOT_LOADED;
  private queue: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;

  constructor(@inject(OWNED_PARTS_REPOSITORY) private readonly repository: IOwnedPartsRepository) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): OwnedPartsView {
    return this.state;
  }

  load(): Promise<void> {
    this.loading ??= this.serially(async () => {
      const stored = await this.repository.read();
      if (!stored.ok) {
        this.publish({
          owned: null,
          problem: `the saved parts can't be read: ${issueText(stored.issues)}`,
        });
        return;
      }
      if (stored.value === null) {
        this.publish({ owned: null, problem: null });
        return;
      }
      const read = readOwnedPartsCsv(stored.value.name, stored.value.text);
      this.publish(
        read.ok ? { owned: read.owned, problem: null } : { owned: null, problem: read.problem },
      );
    });
    return this.loading;
  }

  importFile(file: TextFile): Promise<void> {
    return this.serially(async () => {
      const { name } = file;
      const text = await file.text();
      const read = readOwnedPartsCsv(name, text);
      if (!read.ok) {
        this.publish({ problem: read.problem });
        return;
      }
      await this.repository.write({ version: OWNED_PARTS_FILE_VERSION, name, text });
      this.publish({ owned: read.owned, problem: null });
    });
  }

  clear(): Promise<void> {
    return this.serially(async () => {
      await this.repository.clear();
      this.publish({ owned: null, problem: null });
    });
  }

  private serially(step: () => Promise<void>): Promise<void> {
    const run = this.queue.then(step).catch((error: unknown) => {
      this.publish({ problem: problemText(error) });
    });
    this.queue = run;
    return run;
  }

  private publish(patch: Partial<Omit<OwnedPartsView, "loaded">>): void {
    this.state = { ...this.state, ...patch, loaded: true };
    for (const listener of this.listeners) listener();
  }
}
