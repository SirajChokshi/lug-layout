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
      headers: { Range: "bytes=0-9" },
      payload: "",
      signature: "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    },
    {
      name: "PUT object with an encoded key",
      method: "PUT" as const,
      path: `/${encodeObjectPath("test$file.text")}`,
      headers: {
        Date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payload: "Welcome to Amazon S3.",
      signature: "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    },
  ])("matches the AWS SigV4 example: $name", ({ method, path, headers, payload, signature }) => {
    const signed = signS3Request(
      { method, host: AWS_EXAMPLE_HOST, path, headers, payloadSha256: sha256Hex(payload) },
      AWS_EXAMPLE_CREDENTIALS,
      "us-east-1",
      AWS_EXAMPLE_DATE,
    );
    expect(signed["authorization"]).toMatch(new RegExp(`Signature=${signature}$`, "u"));
  });
});

const PAGE_KEYS = 2;
const BUCKET = "bucket";

async function withBucket(
  keys: ReadonlyArray<string>,
  run: (store: R2ObjectStore, requests: string[], held: Set<string>) => Promise<void>,
): Promise<void> {
  const held = new Set(keys);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://bucket.test");
    requests.push(`${request.method} ${url.search}`);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      if (request.method === "POST" && url.searchParams.has("delete")) {
        const md5 = createHash("md5").update(body).digest("base64");
        if (request.headers["content-md5"] !== md5) {
          response.writeHead(400).end("<Error><Code>BadDigest</Code></Error>");
          return;
        }
        for (const [, key = ""] of body.toString().matchAll(/<Key>([^<]*)<\/Key>/gu)) {
          held.delete(key);
        }
        response.writeHead(200).end("<DeleteResult></DeleteResult>");
        return;
      }
      const prefix = url.searchParams.get("prefix") ?? "";
      const listed = [...held].filter((key) => key.startsWith(prefix)).toSorted();
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = listed.slice(start, start + PAGE_KEYS);
      const truncated = start + PAGE_KEYS < listed.length;
      const contents = page.map((key) => `<Contents><Key>${key}</Key><Size>3</Size></Contents>`);
      response
        .writeHead(200)
        .end(
          `<ListBucketResult>${contents.join("")}<IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + PAGE_KEYS}</NextContinuationToken>` : ""}</ListBucketResult>`,
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
    const keys = ["p/a", "p/b", "p/c", "p/d", "p/e", "q/z"];
    await withBucket(keys, async (store, requests) => {
      const listed = await store.list("p/");

      expect(listed).toEqual(["p/a", "p/b", "p/c", "p/d", "p/e"].map((key) => ({ key, size: 3 })));
      expect(requests).toHaveLength(Math.ceil(5 / PAGE_KEYS));
    });
  });

  it("deletes keys in batches of at most a thousand, and a key already gone counts as deleted", async () => {
    const keys = Array.from({ length: 1001 }, (_, i) => `p/${i}`);
    await withBucket(keys, async (store, requests, held) => {
      await store.delete([...keys, "p/gone"]);

      expect(held.size).toBe(0);
      expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(2);
    });
  });
});
