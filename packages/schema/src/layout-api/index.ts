import * as v from "valibot";
import {
  Count,
  SafeInteger,
  SuperChunk,
  WorldManifestV1,
  WorldName,
  shardName,
  strictMessage,
} from "../world/index.ts";

export const SHA256_HEX_DIGITS = 64;
export const SHA256_PATTERN = `[0-9a-f]{${SHA256_HEX_DIGITS}}`;
export const RECORD_ID_BYTES = 16;
export const RECORD_ID_PATTERN = `[0-9a-f]{${RECORD_ID_BYTES * 2}}`;
export const TOKEN_BYTES = 32;
export const TOKEN_CHARACTERS = 43;
export const TOKEN_PATTERN = `[A-Za-z0-9_-]{${TOKEN_CHARACTERS}}`;
export const EMAIL_MAX_LENGTH = 254;
export const IMPORT_NAME_MAX_LENGTH = 255;
export const SIGN_IN_FRAGMENT_KEY = "sign-in";
export const SNAPSHOT_FORMAT = "brr.world-snapshot";
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const MEBIBYTE = 1024 * 1024;
export const MAX_SHARD_BYTES = 16 * MEBIBYTE;
export const MAX_IMPORT_BYTES = 32 * MEBIBYTE;
export const MAX_REQUEST_JSON_BYTES = 4 * MEBIBYTE;

const VERSION_PAGE_LIMIT = { fallback: "50", max: 200 } as const;
const SHARD_NAME = /^-?(?:0|[1-9]\d*)_-?(?:0|[1-9]\d*)$/u;
const PATH_SEPARATORS = /[/\\]/u;

const anchored = (pattern: string): RegExp => new RegExp(`^${pattern}$`, "u");

export const Sha256 = v.pipe(
  v.string(),
  v.regex(anchored(SHA256_PATTERN), "is not a lowercase SHA-256 hex digest"),
);
export type Sha256 = v.InferOutput<typeof Sha256>;

export const RecordId = v.pipe(v.string(), v.regex(anchored(RECORD_ID_PATTERN), "is not an id"));
export type RecordId = v.InferOutput<typeof RecordId>;

export const Token = v.pipe(v.string(), v.regex(anchored(TOKEN_PATTERN), "is not a token"));
export type Token = v.InferOutput<typeof Token>;

export const EmailAddress = v.pipe(
  v.string(),
  v.trim(),
  v.maxLength(EMAIL_MAX_LENGTH, `must be at most ${EMAIL_MAX_LENGTH} characters`),
  v.email("is not an email address"),
  v.toLowerCase(),
);
export type EmailAddress = v.InferOutput<typeof EmailAddress>;

export const VersionNumber = v.pipe(SafeInteger, v.minValue(1, "must be a version number from 1"));
export type VersionNumber = v.InferOutput<typeof VersionNumber>;

const Timestamp = v.pipe(v.string(), v.isoTimestamp("is not an ISO timestamp"));

export const ShardName = v.pipe(
  v.string(),
  v.regex(SHARD_NAME, 'is not a super-chunk name "<sx>_<sz>"'),
);

export const ImportName = v.pipe(
  v.string(),
  v.check(
    (name) =>
      name.trim() !== "" && name.length <= IMPORT_NAME_MAX_LENGTH && !PATH_SEPARATORS.test(name),
    `must be a file name of 1 to ${IMPORT_NAME_MAX_LENGTH} characters without slashes`,
  ),
);

export const ImportEntry = v.strictObject({ sha256: Sha256, name: ImportName }, strictMessage);
export type ImportEntry = v.InferOutput<typeof ImportEntry>;

function namesEveryManifestShard(
  manifest: WorldManifestV1,
  shards: Readonly<Record<string, string>>,
): boolean {
  const named = Object.keys(shards);
  return (
    named.length === manifest.shards.length &&
    manifest.shards.every((entry) => Object.hasOwn(shards, shardName(entry.superChunk)))
  );
}

function ascendingImports(imports: ReadonlyArray<ImportEntry>): boolean {
  return imports.every((entry, index) => {
    const previous = imports[index - 1];
    return previous === undefined || previous.sha256 < entry.sha256;
  });
}

export const WorldSnapshot = v.pipe(
  v.strictObject(
    {
      format: v.literal(SNAPSHOT_FORMAT, `must be "${SNAPSHOT_FORMAT}"`),
      schemaVersion: v.literal(SNAPSHOT_SCHEMA_VERSION, `must be ${SNAPSHOT_SCHEMA_VERSION}`),
      manifest: WorldManifestV1,
      shards: v.record(ShardName, Sha256),
      imports: v.pipe(
        v.array(ImportEntry),
        v.check(
          (imports: ImportEntry[]) => ascendingImports(imports),
          "must list each file once, in ascending SHA-256 order",
        ),
      ),
    },
    strictMessage,
  ),
  v.forward(
    v.partialCheck(
      [["manifest"], ["shards"]],
      (snapshot) => namesEveryManifestShard(snapshot.manifest, snapshot.shards),
      "must name exactly the manifest's super-chunks, each with its shard's SHA-256",
    ),
    ["shards"],
  ),
);
export type WorldSnapshot = v.InferOutput<typeof WorldSnapshot>;

export function signInLink(appOrigin: string, token: Token): string {
  return `${appOrigin}/#${SIGN_IN_FRAGMENT_KEY}=${token}`;
}

export const SignInLinkRequest = v.strictObject({ email: EmailAddress }, strictMessage);
export type SignInLinkRequest = v.InferOutput<typeof SignInLinkRequest>;

export const SignInLinkResponse = v.object({ expiresAt: Timestamp });
export type SignInLinkResponse = v.InferOutput<typeof SignInLinkResponse>;

export const SessionRequest = v.strictObject({ token: Token }, strictMessage);
export type SessionRequest = v.InferOutput<typeof SessionRequest>;

export const Account = v.object({ id: RecordId, email: v.string(), createdAt: Timestamp });
export type Account = v.InferOutput<typeof Account>;

export const SessionResponse = v.object({
  session: v.object({ token: Token, expiresAt: Timestamp }),
  account: Account,
});
export type SessionResponse = v.InferOutput<typeof SessionResponse>;

export const StorageUsage = v.object({
  bytes: Count,
  quotaBytes: Count,
  worlds: Count,
  worldLimit: Count,
});
export type StorageUsage = v.InferOutput<typeof StorageUsage>;

export const AccountResponse = v.object({ account: Account, usage: StorageUsage });
export type AccountResponse = v.InferOutput<typeof AccountResponse>;

export const CreateWorldRequest = v.strictObject({ name: WorldName }, strictMessage);
export type CreateWorldRequest = v.InferOutput<typeof CreateWorldRequest>;

export const WorldSummary = v.object({
  id: RecordId,
  name: v.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  head: v.nullable(VersionNumber),
});
export type WorldSummary = v.InferOutput<typeof WorldSummary>;

export const WorldResponse = v.object({ world: WorldSummary });
export type WorldResponse = v.InferOutput<typeof WorldResponse>;

export const WorldListResponse = v.object({ worlds: v.array(WorldSummary) });
export type WorldListResponse = v.InferOutput<typeof WorldListResponse>;

export const StoredFileResponse = v.object({ sha256: Sha256, bytes: Count });
export type StoredFileResponse = v.InferOutput<typeof StoredFileResponse>;

export const SaveVersionRequest = v.strictObject(
  { parent: v.nullable(VersionNumber), snapshot: WorldSnapshot },
  strictMessage,
);
export type SaveVersionRequest = v.InferOutput<typeof SaveVersionRequest>;

export const VersionSummary = v.object({
  version: VersionNumber,
  parent: v.nullable(VersionNumber),
  name: v.string(),
  placements: Count,
  track: Count,
  snapshot: Sha256,
  savedBy: RecordId,
  savedAt: Timestamp,
});
export type VersionSummary = v.InferOutput<typeof VersionSummary>;

export const SaveVersionResponse = v.object({
  version: VersionSummary,
  previousHead: v.nullable(VersionNumber),
});
export type SaveVersionResponse = v.InferOutput<typeof SaveVersionResponse>;

export const MissingFilesResponse = v.object({
  error: v.string(),
  missing: v.object({ shards: v.array(Sha256), imports: v.array(Sha256) }),
});
export type MissingFilesResponse = v.InferOutput<typeof MissingFilesResponse>;

export const VersionListResponse = v.object({
  versions: v.array(VersionSummary),
  next: v.nullable(v.pipe(v.string(), v.url())),
});
export type VersionListResponse = v.InferOutput<typeof VersionListResponse>;

export const VersionResponse = v.object({ version: VersionSummary, snapshot: WorldSnapshot });
export type VersionResponse = v.InferOutput<typeof VersionResponse>;

export const ErrorResponse = v.object({ error: v.string() });
export type ErrorResponse = v.InferOutput<typeof ErrorResponse>;

const DIGITS = /^[0-9]{1,15}$/u;

export const VersionPageParams = v.object({
  before: v.optional(
    v.pipe(
      v.string(),
      v.regex(DIGITS, "must be a version number"),
      v.transform(Number),
      VersionNumber,
    ),
  ),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(DIGITS, `must be an integer from 1 to ${VERSION_PAGE_LIMIT.max}`),
      v.transform(Number),
      v.minValue(1, `must be an integer from 1 to ${VERSION_PAGE_LIMIT.max}`),
      v.maxValue(VERSION_PAGE_LIMIT.max, `must be an integer from 1 to ${VERSION_PAGE_LIMIT.max}`),
    ),
    VERSION_PAGE_LIMIT.fallback,
  ),
});
export type VersionPageParams = v.InferOutput<typeof VersionPageParams>;

const Integer = SafeInteger;

export const ShardSummary = v.strictObject(
  {
    superChunk: SuperChunk,
    placements: Count,
    track: Count,
    trackIndices: v.array(Count),
    imports: v.array(Sha256),
  },
  strictMessage,
);
export type ShardSummary = v.InferOutput<typeof ShardSummary>;

export const AccountRow = v.object({ id: RecordId, email: v.string(), created_at: Integer });
export type AccountRow = v.InferOutput<typeof AccountRow>;

export const SignInLinkRow = v.object({
  token_hash: Sha256,
  email: v.string(),
  created_at: Integer,
  expires_at: Integer,
});
export type SignInLinkRow = v.InferOutput<typeof SignInLinkRow>;

export const SessionRow = v.object({
  token_hash: Sha256,
  account_id: RecordId,
  created_at: Integer,
  expires_at: Integer,
});
export type SessionRow = v.InferOutput<typeof SessionRow>;

export const WorldRow = v.object({
  id: RecordId,
  owner_id: RecordId,
  name: v.string(),
  created_at: Integer,
  updated_at: Integer,
  head: v.nullable(Integer),
});
export type WorldRow = v.InferOutput<typeof WorldRow>;

export const StoredFileRow = v.object({ sha256: Sha256, bytes: Integer });
export type StoredFileRow = v.InferOutput<typeof StoredFileRow>;

export const StoredShardRow = v.object({
  ...StoredFileRow.entries,
  summary: v.pipe(v.string(), v.parseJson(), ShardSummary),
});
export type StoredShardRow = v.InferOutput<typeof StoredShardRow>;

export const VersionRow = v.object({
  version: Integer,
  parent: v.nullable(Integer),
  snapshot_sha256: Sha256,
  name: v.string(),
  placements: Integer,
  track: Integer,
  saved_by: RecordId,
  saved_at: Integer,
});
export type VersionRow = v.InferOutput<typeof VersionRow>;
