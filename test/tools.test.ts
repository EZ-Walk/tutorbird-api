import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { clientDeps } from "../src/tutorbird-client";
import {
  LIVE_WRITE,
  TOOL_NAMES,
  addPayment,
  addStudent,
  listStudents,
  scanTransactions,
  updateFamilyName,
} from "../src/tools";

const KEY = "Bearer test-key-do-not-log-9f3a";

type Seen = { url: string; method: string; authorization: string; body: unknown };

function install(handler: (seen: Seen) => Response): Seen[] {
  const seen: Seen[] = [];
  clientDeps.sleep = async () => {};
  clientDeps.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body ? String(init.body) : undefined;
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: headers.get("Authorization") ?? "",
      body: raw ? (JSON.parse(raw) as unknown) : undefined,
    });
    return handler(seen.at(-1)!);
  };
  return seen;
}

function json(status: number, body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  clientDeps.fetch = globalThis.fetch;
  clientDeps.sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
});

describe("scanTransactions", () => {
  it("matches Description exactly and rejects a short page", () => {
    const clear = scanTransactions(
      { ItemSubset: [{ Description: "other", ID: "rcv_1" }], TotalItemCount: 1 },
      "receipt-100",
    );
    assert.equal(clear.kind, "clear");

    const hit = scanTransactions(
      { ItemSubset: [{ Description: " receipt-100 ", ID: "rcv_9", AccountBalance: 0 }], TotalItemCount: 1 },
      "receipt-100",
    );
    assert.equal(hit.kind, "duplicate");
    if (hit.kind === "duplicate") assert.equal(hit.matches[0]?.ID, "rcv_9");

    const short = scanTransactions(
      { ItemSubset: [{ Description: "receipt-100" }], TotalItemCount: 4 },
      "receipt-100",
    );
    assert.equal(short.kind, "incomplete");
  });
});

describe("tools", () => {
  it("lists read tools before writes and warns on every write", async () => {
    const reads = TOOL_NAMES.filter((name) => name.startsWith("list_") || name.startsWith("get_"));
    const writes = TOOL_NAMES.filter((name) => !reads.includes(name));
    assert.deepEqual(TOOL_NAMES.slice(0, reads.length), reads);
    assert.ok(writes.includes("add_payment"));
    assert.equal(LIVE_WRITE.includes("live, immediate, and permanent"), true);
    assert.equal(TOOL_NAMES.some((name) => name.includes("event") || name.includes("attendance")), false);
  });

  it("passes the caller key through on a read", async () => {
    const seen = install(() => json(200, { ItemSubset: [{ FirstName: "Ada" }], TotalItemCount: 1 }));
    const result = await listStudents(KEY);
    assert.equal(result.isError, undefined);
    assert.equal(seen[0]?.authorization, KEY);
    assert.equal(seen[0]?.url, "https://api.tutorbird.com/v1/students");
    assert.match(result.content[0].text, /Ada/);
  });

  it("redacts a key echoed in an error body", async () => {
    install(() => json(500, { detail: "saw test-key-do-not-log-9f3a" }));
    const result = await listStudents(KEY);
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text.includes("test-key-do-not-log-9f3a"), false);
  });

  it("creates a student with Adult: {} and does not retry the POST", async () => {
    const seen = install(() => json(200, "sdt_example"));
    const result = await addStudent(KEY, {
      confirm: true,
      FirstName: "Ada",
      LastName: "Lovelace",
      Family: { FamilyName: "Lovelace" },
      Status: "Trial",
    });
    assert.equal(result.isError, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "POST");
    assert.equal(seen[0]?.url, "https://api.tutorbird.com/v1/students");
    assert.deepEqual(seen[0]?.body, {
      FirstName: "Ada",
      LastName: "Lovelace",
      Family: { FamilyName: "Lovelace" },
      Adult: {},
      Status: "Trial",
    });
    assert.match(result.content[0].text, /sdt_example/);
  });

  it("does not post a payment when the reference already exists", async () => {
    const seen = install(() =>
      json(200, {
        ItemSubset: [{ ID: "rcv_existing", Description: "receipt-100", FamilyID: "fml_example", Amount: 1 }],
        TotalItemCount: 1,
      }),
    );
    const result = await addPayment(KEY, {
      confirm: true,
      reference: "receipt-100",
      FamilyID: "fml_example",
      StudentID: "sdt_example",
      Amount: 12.5,
      Timestamp: "2026-10-30",
      PaymentMethod: "Venmo",
    });
    assert.equal(result.isError, undefined);
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.method, "GET");
    assert.match(result.content[0].text, /Nothing was posted/);
    assert.match(result.content[0].text, /rcv_existing/);
  });

  it("posts a payment only after a clear transaction list", async () => {
    const seen = install((call) => {
      if (call.method === "GET") return json(200, { ItemSubset: [], TotalItemCount: 0 });
      return json(200, "rcv_new");
    });
    const result = await addPayment(KEY, {
      confirm: true,
      reference: "receipt-200",
      FamilyID: "fml_example",
      StudentID: "sdt_example",
      Amount: -3,
      Timestamp: "2026-10-30",
      InvoiceIDsToBeMarkedPaid: [],
    });
    assert.equal(seen.map((call) => call.method).join(","), "GET,POST");
    assert.equal(seen[1]?.url, "https://api.tutorbird.com/v1/transactions");
    assert.deepEqual(seen[1]?.body, {
      TransactionType: "Payment",
      FamilyID: "fml_example",
      StudentID: "sdt_example",
      Amount: -3,
      Description: "receipt-200",
      Timestamp: "2026-10-30",
      InvoiceIDsToBeMarkedPaid: [],
    });
    assert.match(result.content[0].text, /rcv_new/);
    assert.equal(result.content[0].text.includes("posted\": true") || result.content[0].text.includes('"posted": true'), true);
  });

  it("rechecks transactions before retrying a rate-limited payment", async () => {
    let posts = 0;
    const seen = install((call) => {
      if (call.method === "GET") {
        const already = posts > 0;
        return json(200, {
          ItemSubset: already ? [{ Description: "receipt-300", ID: "rcv_late" }] : [],
          TotalItemCount: already ? 1 : 0,
        });
      }
      posts += 1;
      return json(429, { error: "slow" }, { "retry-after": "0" });
    });
    const result = await addPayment(KEY, {
      confirm: true,
      reference: "receipt-300",
      FamilyID: "fml_example",
      StudentID: "sdt_example",
      Amount: 1,
      Timestamp: "2026-10-30T14:00:00",
    });
    assert.equal(posts, 1);
    assert.equal(seen.filter((call) => call.method === "POST").length, 1);
    assert.match(result.content[0].text, /Nothing was posted/);
    assert.match(result.content[0].text, /rcv_late/);
  });

  it("refuses a payment when the transaction list is incomplete", async () => {
    const seen = install(() => json(200, { ItemSubset: [], TotalItemCount: 2 }));
    const result = await addPayment(KEY, {
      confirm: true,
      reference: "receipt-400",
      FamilyID: "fml_example",
      StudentID: "sdt_example",
      Amount: 1,
      Timestamp: "2026-10-30",
    });
    assert.equal(result.isError, true);
    assert.equal(seen.some((call) => call.method === "POST"), false);
    assert.match(result.content[0].text, /complete list/);
  });

  it("warns that a family name write appends", async () => {
    install(() => json(200, true));
    const result = await updateFamilyName(KEY, {
      confirm: true,
      familyId: "fml_example",
      FamilyName: "Studio",
    });
    assert.match(result.content[0].text, /'; '/);
  });
});
