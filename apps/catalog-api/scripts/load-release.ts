import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { RELEASE_ID_HEX_LENGTH, releaseObjectKey } from "../src/release-schema.ts";
import { releaseCounts, releaseStatements, sourceSchemaProblems } from "./release-sql.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(packageRoot, "..", "..");
const sqlCache = join(repoRoot, ".cache", "catalog-release");
const wranglerBin = join(packageRoot, "node_modules", ".bin", "wrangler");
const SQLITE_CONTENT_TYPE = "application/vnd.sqlite3";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";

interface WranglerConfig {
  readonly d1_databases: ReadonlyArray<{
    readonly binding: string;
    readonly database_name: string;
  }>;
  readonly r2_buckets: ReadonlyArray<{ readonly binding: string; readonly bucket_name: string }>;
}

const usage = `Usage: pnpm --filter @brr/catalog-api load-release --sqlite <file> --source <label> (--local [--persist-to <dir>] | --remote) [--database <name>] [--bucket <name>] [--no-promote]`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      sqlite: { type: "string" },
      source: { type: "string" },
      local: { type: "boolean", default: false },
      remote: { type: "boolean", default: false },
      "persist-to": { type: "string" },
      database: { type: "string" },
      bucket: { type: "string" },
      "no-promote": { type: "boolean", default: false },
    },
  });
  if (
    values.sqlite === undefined ||
    values.source === undefined ||
    values.local === values.remote
  ) {
    throw new Error(usage);
  }
  if (values.remote && values["persist-to"] !== undefined) {
    throw new Error("--persist-to applies only to --local");
  }
  const config = JSON.parse(
    await readFile(join(packageRoot, "wrangler.json"), "utf8"),
  ) as WranglerConfig;
  const database = values.database ?? config.d1_databases[0]?.database_name;
  const bucket = values.bucket ?? config.r2_buckets[0]?.bucket_name;
  if (database === undefined || bucket === undefined) {
    throw new Error("wrangler.json must declare one D1 database and one R2 bucket");
  }
  const sqlitePath = resolve(values.sqlite);
  const started = performance.now();
  const sha256 = await fileSha256(sqlitePath);
  const id = sha256.slice(0, RELEASE_ID_HEX_LENGTH);
  const bytes = (await stat(sqlitePath)).size;
  const objectKey = releaseObjectKey(id);
  const source = new DatabaseSync(sqlitePath, { readOnly: true });
  const problems = sourceSchemaProblems(source);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  await mkdir(sqlCache, { recursive: true });
  const sqlPath = join(sqlCache, `${id}.sql`);
  const out = createWriteStream(sqlPath);
  let statements = 0;
  for (const statement of releaseStatements(
    source,
    { id, sha256, bytes, objectKey, source: values.source, loadedAt: new Date().toISOString() },
    !values["no-promote"],
  )) {
    if (!out.write(`${statement};\n`)) await once(out, "drain");
    statements += 1;
  }
  out.end();
  await finished(out);
  const counts = releaseCounts(source);
  source.close();
  const generated = performance.now();
  const target = values.remote ? ["--remote"] : ["--local", ...persistArgs(values["persist-to"])];
  wrangler([
    "r2",
    "object",
    "put",
    `${bucket}/${objectKey}`,
    "--file",
    sqlitePath,
    "--content-type",
    SQLITE_CONTENT_TYPE,
    "--cache-control",
    IMMUTABLE_CACHE,
    ...target,
  ]);
  const uploaded = performance.now();
  wrangler(["d1", "execute", database, "--file", sqlPath, "--yes", ...target], "ignore");
  const loaded = performance.now();
  process.stdout.write(
    `${JSON.stringify(
      {
        release: id,
        sha256,
        bytes,
        objectKey,
        database,
        bucket,
        target: values.remote ? "remote" : "local",
        promoted: !values["no-promote"],
        statements,
        sqlBytes: (await stat(sqlPath)).size,
        counts,
        seconds: {
          generate: round((generated - started) / 1000),
          upload: round((uploaded - generated) / 1000),
          load: round((loaded - uploaded) / 1000),
        },
      },
      null,
      2,
    )}\n`,
  );
}

function persistArgs(persistTo: string | undefined): ReadonlyArray<string> {
  return persistTo === undefined ? [] : ["--persist-to", resolve(persistTo)];
}

function wrangler(args: ReadonlyArray<string>, stdout: "inherit" | "ignore" = "inherit"): void {
  const result = spawnSync(wranglerBin, args, {
    cwd: packageRoot,
    stdio: ["ignore", stdout, "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (result.status !== 0) {
    throw new Error(`wrangler ${args.slice(0, 2).join(" ")} failed with status ${result.status}`);
  }
}

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

await main();
