import { createHash, createHmac } from "node:crypto";

export interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface S3Request {
  readonly method: "GET" | "HEAD" | "PUT" | "POST";
  readonly host: string;
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly payloadSha256: string;
}

const ALGORITHM = "AWS4-HMAC-SHA256";
const SERVICE = "s3";
const R2_REGION = "auto";
const SCOPE_TERMINATOR = "aws4_request";
const UNRESERVED_EXTRAS = /[!'()*]/gu;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function hmac(key: Uint8Array | string, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
}

function encodeComponent(value: string): string {
  return encodeURIComponent(value).replace(
    UNRESERVED_EXTRAS,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function encodeObjectPath(path: string): string {
  return path.split("/").map(encodeComponent).join("/");
}

function canonicalQuery(query: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(query ?? {})
    .map(([name, value]) => `${encodeComponent(name)}=${encodeComponent(value)}`)
    .toSorted()
    .join("&");
}

export function signS3Request(
  request: S3Request,
  credentials: S3Credentials,
  region: string,
  date: Date,
): Record<string, string> {
  const timestamp = amzDate(date);
  const day = timestamp.slice(0, 8);
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), value.trim()]),
    ),
    host: request.host,
    "x-amz-content-sha256": request.payloadSha256,
    "x-amz-date": timestamp,
  };
  const names = Object.keys(headers).toSorted();
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    request.method,
    request.path,
    canonicalQuery(request.query),
    ...names.map((name) => `${name}:${headers[name]}`),
    "",
    signedHeaders,
    request.payloadSha256,
  ].join("\n");
  const scope = `${day}/${region}/${SERVICE}/${SCOPE_TERMINATOR}`;
  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = [day, region, SERVICE, SCOPE_TERMINATOR].reduce<Uint8Array | string>(
    (key, part) => hmac(key, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization: `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export interface ObjectStore {
  has(key: string): Promise<boolean>;
  put(key: string, body: Uint8Array, headers: Readonly<Record<string, string>>): Promise<void>;
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
}

export interface PrunableStore extends ObjectStore {
  get(key: string): Promise<Uint8Array | undefined>;
  list(prefix: string): Promise<ReadonlyArray<StoredObject>>;
  delete(keys: ReadonlyArray<string>): Promise<void>;
}

const DELETE_OBJECTS_LIMIT = 1000;

function xmlEscaped(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function deleteRequest(keys: ReadonlyArray<string>): Uint8Array {
  const objects = keys.map((key) => `<Object><Key>${xmlEscaped(key)}</Key></Object>`).join("");
  return new TextEncoder().encode(`<Delete><Quiet>true</Quiet>${objects}</Delete>`);
}

const XML_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

function xmlText(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => XML_ENTITIES[entity] ?? entity);
}

function xmlField(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>([^<]*)</${name}>`, "u").exec(xml);
  return match?.[1] === undefined ? undefined : xmlText(match[1]);
}

function listedObjects(xml: string): StoredObject[] {
  return [...xml.matchAll(/<Contents>(.*?)<\/Contents>/gsu)].map(([, entry = ""]) => {
    const key = xmlField(entry, "Key");
    const size = Number(xmlField(entry, "Size"));
    if (key === undefined || !Number.isSafeInteger(size)) {
      throw new Error(`a ListObjectsV2 entry has no key or size: ${entry}`);
    }
    return { key, size };
  });
}

export interface R2Bucket {
  readonly endpoint: string;
  readonly bucket: string;
  readonly credentials: S3Credentials;
}

export class R2ObjectStore implements PrunableStore {
  private readonly target: R2Bucket;

  constructor(target: R2Bucket) {
    this.target = target;
  }

  private async send(
    method: S3Request["method"],
    key: string,
    body: Uint8Array | undefined,
    headers: Readonly<Record<string, string>>,
    query?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    const endpoint = new URL(this.target.endpoint);
    const bucketPath = `/${encodeObjectPath(this.target.bucket)}`;
    const path = query === undefined ? `${bucketPath}/${encodeObjectPath(key)}` : bucketPath;
    const signed = signS3Request(
      {
        method,
        host: endpoint.host,
        path,
        ...(query === undefined ? {} : { query }),
        headers,
        payloadSha256: sha256Hex(body ?? ""),
      },
      this.target.credentials,
      R2_REGION,
      new Date(),
    );
    const { host: _host, ...sent } = signed;
    const search = canonicalQuery(query);
    return fetch(new URL(search === "" ? path : `${path}?${search}`, endpoint), {
      method,
      headers: sent,
      ...(body === undefined ? {} : { body }),
    });
  }

  async has(key: string): Promise<boolean> {
    const response = await this.send("HEAD", key, undefined, {});
    if (response.status === 404) return false;
    if (!response.ok) throw new Error(`HEAD ${key} failed with ${response.status}`);
    return true;
  }

  async put(
    key: string,
    body: Uint8Array,
    headers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const response = await this.send("PUT", key, body, headers);
    if (!response.ok) {
      throw new Error(`PUT ${key} failed with ${response.status}: ${await response.text()}`);
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.send("GET", key, undefined, {});
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GET ${key} failed with ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(prefix: string): Promise<ReadonlyArray<StoredObject>> {
    const objects: StoredObject[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { "list-type": "2", prefix };
      if (token !== undefined) query["continuation-token"] = token;
      const response = await this.send("GET", "", undefined, {}, query);
      if (!response.ok) throw new Error(`listing ${prefix} failed with ${response.status}`);
      const xml = await response.text();
      objects.push(...listedObjects(xml));
      token =
        xmlField(xml, "IsTruncated") === "true"
          ? xmlField(xml, "NextContinuationToken")
          : undefined;
    } while (token !== undefined);
    return objects;
  }

  async delete(keys: ReadonlyArray<string>): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_OBJECTS_LIMIT) {
      const body = deleteRequest(keys.slice(start, start + DELETE_OBJECTS_LIMIT));
      const response = await this.send(
        "POST",
        "",
        body,
        {
          "Content-Type": "application/xml",
          "Content-MD5": createHash("md5").update(body).digest("base64"),
        },
        { delete: "" },
      );
      const xml = await response.text();
      if (!response.ok) throw new Error(`DeleteObjects failed with ${response.status}: ${xml}`);
      const failed = [...xml.matchAll(/<Error>(.*?)<\/Error>/gsu)].map(([, entry = ""]) => entry);
      if (failed.length > 0) throw new Error(`DeleteObjects refused: ${failed.join("; ")}`);
    }
  }
}
