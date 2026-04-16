import { afterEach, beforeEach, describe, expect, it } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
// @ts-expect-error — CommonJS module
import httpMod from "../../_bmad-addons/lib/runtime/http.js";

const { postJson, MAX_RESPONSE_BYTES } = httpMod as {
  postJson: (url: string, body: unknown, opts?: { headers?: Record<string, string>; timeoutMs?: number }) =>
    Promise<{ statusCode: number; body: string; json: unknown }>;
  MAX_RESPONSE_BYTES: number;
};

describe("http postJson", () => {
  let server: http.Server;
  let baseUrl: string;

  function start(handler: http.RequestListener): Promise<void> {
    return new Promise((resolve) => {
      server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  afterEach(() => new Promise<void>((resolve) => {
    if (!server) { resolve(); return; }
    server.close(() => resolve());
  }));

  it("exposes a 5 MB body cap", () => {
    expect(MAX_RESPONSE_BYTES).toBe(5 * 1024 * 1024);
  });

  it("resolves on a normal 201 with JSON body", async () => {
    await start((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true, echo: JSON.parse(body) }));
      });
    });

    const r = await postJson(baseUrl, { hello: "world" });
    expect(r.statusCode).toBe(201);
    expect(r.json).toMatchObject({ ok: true, echo: { hello: "world" } });
  });

  it("surfaces 3xx redirects explicitly (does NOT follow them)", async () => {
    await start((_req, res) => {
      res.writeHead(302, { Location: "https://elsewhere.example.com/x" });
      res.end();
    });
    const r = await postJson(baseUrl, {});
    expect(r.statusCode).toBe(302);
    expect(r.body).toContain("redirect not supported");
    expect(r.body).toContain("elsewhere.example.com");
  });

  it("rejects when response body exceeds MAX_RESPONSE_BYTES", async () => {
    const oversize = Buffer.alloc(MAX_RESPONSE_BYTES + 100, 0x61); // "a"*(cap+100)
    await start((_req, res) => {
      res.writeHead(200);
      res.end(oversize);
    });
    await expect(postJson(baseUrl, {})).rejects.toThrow(/exceeded/i);
  });

  it("rejects on timeout", async () => {
    await start((_req, _res) => { /* never respond */ });
    await expect(postJson(baseUrl, {}, { timeoutMs: 100 })).rejects.toThrow(/timeout/i);
  });

  it("rejects on malformed URL", async () => {
    await expect(postJson("not a url", {})).rejects.toThrow();
  });
});
