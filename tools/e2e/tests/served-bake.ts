import { expect, type BrowserContext, type Route } from "@playwright/test";
import { appendFileSync } from "node:fs";

const LIBRARY_BAKE_ROUTE = "**/library-bake/**";
const LIBRARY_BAKE_FILE = /^\/library-bake\/(?<file>.+)$/u;
const LIBRARY_BAKE_INDEX = /^library-bake\.[0-9a-f]{16}\.json$/u;
const HTTP_NOT_FOUND = 404;
const REQUEST_LOG = process.env["LIBRARY_BAKE_REQUEST_LOG"];
const BAKE_REQUIRED = (process.env["CI"] ?? "") !== "";

export class ServedBake {
  private blocked = false;
  private indexServed = false;
  private warned = false;

  static async install(context: BrowserContext): Promise<ServedBake> {
    const known = installed.get(context);
    if (known) return known;
    const bake = new ServedBake();
    installed.set(context, bake);
    await context.route(LIBRARY_BAKE_ROUTE, (route) => bake.serve(route));
    return bake;
  }

  block(): () => void {
    this.blocked = true;
    return () => {
      this.blocked = false;
    };
  }

  expectIndexServed(): void {
    if (this.blocked || !BAKE_REQUIRED) return;
    expect
      .soft(
        this.indexServed,
        "the import never fetched the library bake's index, so it compiled every official part from the raw library",
      )
      .toBe(true);
  }

  private async serve(route: Route): Promise<void> {
    if (this.blocked) {
      await route.fulfill({ status: HTTP_NOT_FOUND });
      return;
    }
    const response = await route.fetch();
    const file = LIBRARY_BAKE_FILE.exec(new URL(route.request().url()).pathname)?.groups?.["file"];
    if (file !== undefined) this.saw(file, response.status(), response.ok());
    await route.fulfill({ response });
  }

  private saw(file: string, status: number, ok: boolean): void {
    const index = LIBRARY_BAKE_INDEX.test(file);
    if (ok) {
      if (index) this.indexServed = true;
      if (REQUEST_LOG !== undefined) appendFileSync(REQUEST_LOG, `${file}\n`);
      return;
    }
    if (index && !BAKE_REQUIRED) {
      if (!this.warned) {
        process.stderr.write(
          `no library bake is served (library-bake/${file} answered ${status}), so imports compile every official part from the raw library; run library-bake to exercise the bake path\n`,
        );
      }
      this.warned = true;
      return;
    }
    expect
      .soft(
        false,
        `the editor asked for library-bake/${file} and got ${status}, so it compiles that part from the raw library instead of reading its record`,
      )
      .toBe(true);
  }
}

const installed = new WeakMap<BrowserContext, ServedBake>();
