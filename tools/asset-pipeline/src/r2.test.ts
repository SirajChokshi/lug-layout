import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { encodeObjectPath, R2ObjectStore, sha256Hex, signS3Request } from "./r2.ts";

const AWS_EXAMPLE_CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const AWS_EXAMPLE_DATE = new Date("2013-05-24T00:00:00Z");
const AWS_EXAMPLE_HOST = "examplebucket.s3.amazonaws.com";

describe("signS3Request", () => {
  it.each([
    {
      name: "GET object with a range",
      method: "GET" as const,
      path: "/test.txt",
      query: {},
      headers: { Range: "bytes=0-9" },
      payload: "",
      signature: "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    },
    {
      name: "PUT object with an encoded key",
      method: "PUT" as const,
      path: `/${encodeObjectPath("test$file.text")}`,
      query: {},
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payload: "Welcome to Amazon S3.",
      signature: "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    },
    {
      name: "GET bucket lifecycle, a parameter without a value",
      method: "GET" as const,
      path: "/",
      query: { lifecycle: "" },
      headers: {},
      payload: "",
      signature: "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    },
    {
      name: "GET bucket listing with query parameters",
      method: "GET" as const,
      path: "/",
      query: { prefix: "J", "max-keys": "2" },
      headers: {},
      payload: "",
      signature: "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    },
  ])(
    "matches the AWS SigV4 example: $name",
    ({ method, path, query, headers, payload, signature }) => {
      const signed = signS3Request(
        { method, host: AWS_EXAMPLE_HOST, path, query, headers, payloadSha256: sha256Hex(payload) },
        AWS_EXAMPLE_CREDENTIALS,
        "us-east-1",
        AWS_EXAMPLE_DATE,
      );
      expect(signed["authorization"]).toMatch(new RegExp(`Signature=${signature}$`, "u"));
    },
  );
});

const PAGE_KEYS = 2;
const BUCKET = "bucket";
const OK = 200;
const NOT_FOUND = 404;
const REQUESTS_PER_UPLOAD = 2;
const ATTEMPTS_WHEN_FIRST_DROPPED = 2;
const DROPPED_UPLOAD_TIMEOUT_MS = 30_000;
const REFUSED_PREFIX = "p/refused";
const XML_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["&", "&amp;"],
  ["<", "&lt;"],
  [">", "&gt;"],
  ["'", "&#x27;"],
  ["ü", "&#252;"],
  ["€", "&euro;"],
  ["¤", "&#x110000;"],
  ["\ud800", "&#xD800;"],
];

function escaped(text: string): string {
  return XML_ENTITIES.reduce((out, [raw, entity]) => out.replaceAll(raw, entity), text);
}

const NAMED_ENTITIES: ReadonlyArray<readonly [string, string]> = [
  ["'", "&apos;"],
  ['"', "&quot;"],
];

function unescaped(text: string): string {
  return [...NAMED_ENTITIES, ...XML_ENTITIES]
    .toReversed()
    .reduce((out, [raw, entity]) => out.replaceAll(entity, raw), text);
}

interface BucketBehaviour {
  readonly dropsTokens?: boolean;
  readonly dropsFirstConnection?: boolean;
}

async function withBucket(
  keys: ReadonlyArray<string>,
  run: (store: R2ObjectStore, requests: string[], held: Set<string>) => Promise<void>,
  behaviour: BucketBehaviour = {},
): Promise<void> {
  const held = new Set(keys);
  const requests: string[] = [];
  const dropped = new Set<string>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://bucket.test");
    requests.push(`${request.method} ${url.search}`);
    const target = `${request.method} ${url.pathname}${url.search}`;
    if (behaviour.dropsFirstConnection && !dropped.has(target)) {
      dropped.add(target);
      request.socket.destroy();
      return;
    }
    const objectKey = decodeURIComponent(url.pathname.slice(`/${BUCKET}/`.length));
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "HEAD") {
        response.writeHead(held.has(objectKey) ? OK : NOT_FOUND).end();
        return;
      }
      if (request.method === "PUT") {
        held.add(objectKey);
        response.writeHead(OK).end();
        return;
      }
      if (request.method === "POST" && url.searchParams.has("delete")) {
        const md5 = createHash("md5").update(body).digest("base64");
        if (request.headers["content-md5"] !== md5) {
          response.writeHead(400).end("<Error><Code>BadDigest</Code></Error>");
          return;
        }
        const errors: string[] = [];
        for (const [, text = ""] of body.toString().matchAll(/<Key>([^<]*)<\/Key>/gu)) {
          const key = unescaped(text);
          if (key.startsWith(REFUSED_PREFIX)) {
            errors.push(`<Error><Key>${text}</Key><Code>AccessDenied</Code></Error>`);
          } else held.delete(key);
        }
        response.writeHead(200).end(`<DeleteResult>${errors.join("")}</DeleteResult>`);
        return;
      }
      const prefix = url.searchParams.get("prefix") ?? "";
      const listed = [...held].filter((key) => key.startsWith(prefix)).toSorted();
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = listed.slice(start, start + PAGE_KEYS);
      const truncated = start + PAGE_KEYS < listed.length;
      const contents = page.map(
        (key) => `<Contents><Key>${escaped(key)}</Key><Size>3</Size></Contents>`,
      );
      const token =
        truncated && !behaviour.dropsTokens
          ? `<NextContinuationToken>${start + PAGE_KEYS}</NextContinuationToken>`
          : "";
      response
        .writeHead(200)
        .end(
          `<ListBucketResult>${contents.join("")}<IsTruncated>${truncated}</IsTruncated>${token}</ListBucketResult>`,
        );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const store = new R2ObjectStore({
      endpoint: `http://127.0.0.1:${port}`,
      bucket: BUCKET,
      credentials: AWS_EXAMPLE_CREDENTIALS,
    });
    await run(store, requests, held);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("R2ObjectStore listing and deletion", () => {
  it("lists every key under a prefix, following continuation tokens across pages", async () => {
    const keys = ["p/a", "p/a&<b>", "p/c'ü", "p/d", "p/e", "q/z"];
    await withBucket(keys, async (store, requests) => {
      const listed = await store.list("p/");

      expect(listed).toEqual(
        ["p/a", "p/a&<b>", "p/c'ü", "p/d", "p/e"].map((key) => ({ key, size: 3 })),
      );
      expect(requests).toHaveLength(Math.ceil(5 / PAGE_KEYS));
    });
  });

  it.each([
    ["p/€", "&euro;"],
    ["p/¤", "&#x110000;"],
    ["p/\ud800", "&#xD800;"],
  ])(
    "refuses a listing whose key %s comes back with the reference %s, instead of guessing it",
    async (key, reference) => {
      await withBucket([key], async (store) => {
        await expect(store.list("p/")).rejects.toThrow(`unrecognised XML reference ${reference}`);
      });
    },
  );

  it("refuses a listing truncated without a continuation token instead of returning part of it", async () => {
    await withBucket(
      ["p/a", "p/b", "p/c"],
      async (store) => {
        await expect(store.list("p/")).rejects.toThrow(
          "truncated without a new continuation token",
        );
      },
      { dropsTokens: true },
    );
  });

  it("deletes keys in batches of at most a thousand, and a key already gone counts as deleted", async () => {
    const keys = [...Array.from({ length: 999 }, (_, i) => `p/${i}`), "p/a&<b>", "p/c'ü"];
    await withBucket(keys, async (store, requests, held) => {
      await store.delete([...keys, "p/gone"]);

      expect(held.size).toBe(0);
      expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(2);
    });
  });

  it("fails when DeleteObjects answers 200 but refuses a key", async () => {
    const refused = `${REFUSED_PREFIX}/a`;
    await withBucket(["p/a", refused], async (store, _requests, held) => {
      await expect(store.delete(["p/a", refused])).rejects.toThrow(
        `DeleteObjects refused: <Key>${refused}</Key><Code>AccessDenied</Code>`,
      );
      expect([...held]).toEqual([refused]);
    });
  });
});

describe("R2ObjectStore uploads", () => {
  it(
    "uploads every object, HEAD then PUT as an upload does, through an endpoint that drops each request's first connection",
    async () => {
      const keys = ["p/a.glb", "p/b.json", "p/a&<b>.json", "p/c'ü.json"];
      await withBucket(
        [],
        async (store, requests, held) => {
          await Promise.all(
            keys.map(async (key) => {
              if (!(await store.has(key))) {
                await store.put(key, new Uint8Array([1, 2, 3]), { "Content-Type": "model/gltf" });
              }
            }),
          );

          expect([...held].toSorted()).toEqual(keys.toSorted());
          expect(requests).toHaveLength(
            ATTEMPTS_WHEN_FIRST_DROPPED * REQUESTS_PER_UPLOAD * keys.length,
          );
        },
        { dropsFirstConnection: true },
      );
    },
    DROPPED_UPLOAD_TIMEOUT_MS,
  );
});
