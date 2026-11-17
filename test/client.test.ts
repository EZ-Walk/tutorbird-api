import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { backoffMs, clientDeps, tutorbirdRequest, DEFAULT_USER_AGENT } from "../src/tutorbird-client";

const KEY = "Bearer test-key-do-not-log-9f3a";

type Call = { url: string; init: RequestInit | undefined };

function jsonResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  clientDeps.fetch = globalThis.fetch;
  clientDeps.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  clientDeps.now = () => Date.now();
  delete process.env.TUTORBIRD_USER_AGENT;
});

describe("tutorbirdRequest", () => {
  it("sends the bearer header and User-Agent, and does not follow redirects", async () => {
    const calls: Call[] = [];
    clientDeps.fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      return jsonResponse(302, { moved: true }, { location: "https://example.test/steal" });
    };

    const result = await tutorbirdRequest({
      authorization: KEY,
      method: "GET",
      path: "/v1/students",
    });

    assert.equal(result.status, 302);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "https://api.tutorbird.com/v1/students");
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get("Authorization"), KEY);
    assert.equal(headers.get("User-Agent"), DEFAULT_USER_AGENT);
    assert.equal(calls[0]?.init?.redirect, "manual");
  });

  it("uses TUTORBIRD_USER_AGENT when set", async () => {
    process.env.TUTORBIRD_USER_AGENT = "Studio-Assistant/2.0";
    let userAgent = "";
    clientDeps.fetch = async (_input, init) => {
      userAgent = new Headers(init?.headers).get("User-Agent") ?? "";
      return jsonResponse(200, { ItemSubset: [], TotalItemCount: 0 });
    };
    await tutorbirdRequest({ authorization: KEY, method: "GET", path: "/v1/families" });
    assert.equal(userAgent, "Studio-Assistant/2.0");
  });

  it("backs off on 429 for reads and then returns the success", async () => {
    const sleeps: number[] = [];
    const statuses: number[] = [];
    clientDeps.sleep = async (ms) => {
      sleeps.push(ms);
    };
    clientDeps.fetch = async () => {
      const status = statuses.length < 2 ? 429 : 200;
      statuses.push(status);
      if (status === 429) return jsonResponse(429, { error: "slow down" }, { "retry-after": "2" });
      return jsonResponse(200, { ItemSubset: [], TotalItemCount: 0 });
    };

    const result = await tutorbirdRequest({ authorization: KEY, method: "GET", path: "/v1/parents" });
    assert.equal(result.status, 200);
    assert.deepEqual(sleeps, [2000, 2000]);
    assert.equal(statuses.length, 3);
  });

  it("does not retry a POST on 429", async () => {
    let calls = 0;
    clientDeps.fetch = async () => {
      calls += 1;
      return jsonResponse(429, { error: "slow down" });
    };
    const result = await tutorbirdRequest({
      authorization: KEY,
      method: "POST",
      path: "/v1/students",
      body: { FirstName: "Ada", LastName: "Lovelace" },
      retry429: false,
    });
    assert.equal(result.status, 429);
    assert.equal(calls, 1);
  });

  it("refuses undocumented paths before any network call", async () => {
    let calls = 0;
    clientDeps.fetch = async () => {
      calls += 1;
      return jsonResponse(200, {});
    };
    await assert.rejects(
      () => tutorbirdRequest({ authorization: KEY, method: "POST", path: "/v1/payments", body: {} }),
      /undocumented/,
    );
    await assert.rejects(
      () => tutorbirdRequest({ authorization: KEY, method: "GET", path: "/v1/events/evt_1" }),
      /undocumented/,
    );
    assert.equal(calls, 0);
  });

  it("never logs the API key", async () => {
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    clientDeps.fetch = async () => jsonResponse(500, { echo: KEY, detail: "test-key-do-not-log-9f3a" });
    try {
      await tutorbirdRequest({ authorization: KEY, method: "GET", path: "/v1/invoices" });
    } finally {
      console.error = original;
    }
    const logged = lines.join("\n");
    assert.match(logged, /HTTP 500/);
    assert.equal(logged.includes("test-key-do-not-log-9f3a"), false);
    assert.equal(logged.includes("Bearer"), false);
  });
});

describe("backoffMs", () => {
  it("caps a long Retry-After", () => {
    assert.equal(backoffMs(0, "30"), 10_000);
    assert.equal(backoffMs(0, null), 500);
    assert.equal(backoffMs(3, null), 4_000);
  });
});
