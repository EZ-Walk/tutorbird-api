import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { bearerHeader } from "../src/auth";
import { handleMcp } from "../src/http";
import { clientDeps } from "../src/tutorbird-client";
import { LIVE_WRITE, TOOL_NAMES } from "../src/tools";

const KEY = "Bearer test-key-do-not-log-9f3a";

function mcpRequest(method: string, body: unknown, authorization?: string): Request {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (authorization) headers.set("authorization", authorization);
  return new Request("https://mcp.example/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function rpc(body: unknown, authorization?: string): Promise<{ status: number; payload: unknown; text: string }> {
  const response = await handleMcp(mcpRequest("POST", body, authorization));
  const text = await response.text();
  let payload: unknown = text;
  const dataLine = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .at(-1);
  const jsonText = dataLine ?? text;
  try {
    payload = JSON.parse(jsonText) as unknown;
  } catch {
    payload = text;
  }
  return { status: response.status, payload, text };
}

afterEach(() => {
  clientDeps.fetch = globalThis.fetch;
});

describe("bearerHeader", () => {
  it("accepts a Bearer header and rejects anything else", () => {
    assert.equal(bearerHeader(new Request("https://mcp.example/mcp")), null);
    assert.equal(
      bearerHeader(new Request("https://mcp.example/mcp", { headers: { authorization: "Basic abc" } })),
      null,
    );
    assert.equal(
      bearerHeader(new Request("https://mcp.example/mcp", { headers: { authorization: "Bearer " } })),
      null,
    );
    assert.equal(
      bearerHeader(new Request("https://mcp.example/mcp", { headers: { authorization: `  ${KEY}  ` } })),
      KEY,
    );
  });
});

describe("handleMcp", () => {
  it("returns 401 when the bearer token is missing and does not call TutorBird", async () => {
    let calls = 0;
    clientDeps.fetch = async () => {
      calls += 1;
      return new Response("nope", { status: 500 });
    };
    const missing = await handleMcp(mcpRequest("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    const basic = await handleMcp(
      mcpRequest("POST", { jsonrpc: "2.0", id: 1, method: "tools/list" }, "Basic abc"),
    );
    assert.equal(missing.status, 401);
    assert.equal(basic.status, 401);
    assert.equal(calls, 0);
    assert.match(await missing.text(), /Bearer token is required/);
  });

  it("lists confirmed tools with reads first and write warnings", async () => {
    const listed = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, KEY);
    assert.equal(listed.status, 200, listed.text);
    const payload = listed.payload as { result?: { tools?: { name: string; description?: string }[] } };
    const tools = payload.result?.tools ?? [];
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [...TOOL_NAMES],
    );
    const writes = tools.filter((tool) => !tool.name.startsWith("list_") && !tool.name.startsWith("get_"));
    assert.ok(writes.length > 0);
    for (const tool of writes) {
      assert.equal(tool.description?.includes(LIVE_WRITE), true, tool.name);
    }
    assert.equal(listed.text.includes("test-key-do-not-log-9f3a"), false);
  });

  it("forwards the incoming Authorization header on tools/call", async () => {
    let authorization = "";
    clientDeps.fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return new Response(JSON.stringify({ ItemSubset: [], TotalItemCount: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const called = await rpc(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_students", arguments: {} },
      },
      KEY,
    );
    assert.equal(called.status, 200, called.text);
    assert.equal(authorization, KEY);
    assert.match(called.text, /ItemSubset/);
    assert.equal(called.text.includes("test-key-do-not-log-9f3a"), false);
  });
});
