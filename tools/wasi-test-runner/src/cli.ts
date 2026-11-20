import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { WASI } from "node:wasi";

const TARGET = "wasm32-wasip1";
const OUTPUT_LIMIT_BYTES = 1 << 28;
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

interface CargoMessage {
  readonly reason?: string;
  readonly executable?: string | null;
  readonly profile?: { readonly test?: boolean };
}

function testBinaries(cargoArguments: ReadonlyArray<string>): ReadonlyArray<string> {
  const build = spawnSync(
    "cargo",
    ["test", "--target", TARGET, "--no-run", "--message-format=json", ...cargoArguments],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
      maxBuffer: OUTPUT_LIMIT_BYTES,
    },
  );
  if (build.status !== 0) throw new Error(`cargo test for ${TARGET} exited with ${build.status}`);
  return build.stdout
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as CargoMessage)
    .filter((message) => message.reason === "compiler-artifact" && message.profile?.test === true)
    .flatMap((message) => (message.executable ? [message.executable] : []));
}

async function exitCodeUnderWasi(binary: string): Promise<number> {
  const wasi = new WASI({ version: "preview1", args: [binary], env: {}, returnOnExit: true });
  const module = await WebAssembly.compile(await readFile(binary));
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport,
  });
  try {
    return wasi.start(instance);
  } catch (trap) {
    stderr.write(`${binary} trapped: ${String(trap)}\n`);
    return 1;
  }
}

const binaries = testBinaries(argv.slice(2));
if (binaries.length === 0) throw new Error(`no ${TARGET} test binary was built`);
let failed = 0;
for (const binary of binaries) {
  stdout.write(`running ${binary} under WASI\n`);
  if ((await exitCodeUnderWasi(binary)) !== 0) failed += 1;
}
exit(failed === 0 ? 0 : 1);
