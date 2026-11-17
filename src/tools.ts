import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { requestAuth } from "./request-context";
import { isBearer, safeErrorText } from "./auth";
import { redactSecrets } from "./redact";
import {
  backoffMs,
  clientDeps,
  tutorbirdRequest,
  type UpstreamResult,
} from "./tutorbird-client";

export const LIVE_WRITE =
  "This write is live, immediate, and permanent. There is no undo and no test environment.";

const confirm = z
  .literal(true)
  .describe("Must be true. A person approved this exact live write. Otherwise nothing is sent.");

const studentId = z.string().regex(/^sdt_[^/?#\s]+$/);
const parentId = z.string().regex(/^prt_[^/?#\s]+$/);
const familyId = z.string().regex(/^fml_[^/?#\s]+$/);
const status = z.enum(["Active", "Inactive", "Waiting", "Lead", "Trial"]);
const localTimestamp = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})$/)
  .describe("School-local date or date-time. No Z and no numeric offset. The confirmed payment example is YYYY-MM-DD.");

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: boolean;
};

type ToolCtx = { http?: { req?: Request } };

const READ_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} as const;

export const TOOL_NAMES = [
  "list_students",
  "get_student",
  "list_parents",
  "get_parent",
  "list_families",
  "get_family",
  "list_invoices",
  "list_transactions",
  "add_student",
  "update_student",
  "add_parent",
  "update_parent",
  "update_family_name",
  "add_payment",
] as const;

function toolOk(value: unknown, authorization?: string): ToolResult {
  return { content: [{ type: "text", text: render(value, authorization) }] };
}

function toolError(value: unknown, authorization?: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: render(value, authorization) }] };
}

function render(value: unknown, authorization?: string): string {
  const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const text = redactSecrets(raw ?? "null", authorization);
  if (text.length <= 100_000) return text;
  return `${text.slice(0, 100_000)}\n…response truncated…`;
}

function upstreamFailure(method: string, path: string, result: UpstreamResult, authorization: string): string {
  if (result.status >= 300 && result.status < 400) {
    return `TutorBird ${method} ${path} returned HTTP ${result.status}. The proxy did not follow the redirect.`;
  }
  if (result.status === 401) {
    return `TutorBird ${method} ${path} returned HTTP 401. The API key was rejected.`;
  }
  if (result.status === 403) {
    return `TutorBird ${method} ${path} returned HTTP 403. This key cannot perform that action.`;
  }
  if (result.status === 429) {
    return `TutorBird ${method} ${path} returned HTTP 429. Back off before retrying.`;
  }
  return `TutorBird ${method} ${path} returned HTTP ${result.status}. ${render(result.body ?? result.text, authorization)}`;
}

async function readCollection(authorization: string, path: string): Promise<ToolResult> {
  const result = await tutorbirdRequest({ authorization, method: "GET", path });
  if (result.status < 200 || result.status >= 300) {
    return toolError(upstreamFailure("GET", path, result, authorization), authorization);
  }
  return toolOk(result.body, authorization);
}

function authorizationFrom(ctx: ToolCtx): string {
  const header = ctx.http?.req?.headers.get("authorization")?.trim();
  if (header && isBearer(header)) return header;
  const stored = requestAuth.getStore()?.authorization;
  if (stored && isBearer(stored)) return stored;
  throw new Error("Authorization context is missing");
}

async function guarded(ctx: ToolCtx, run: (authorization: string) => Promise<ToolResult>): Promise<ToolResult> {
  let authorization: string | undefined;
  try {
    authorization = authorizationFrom(ctx);
    return await run(authorization);
  } catch (error) {
    return toolError(safeErrorText(error, authorization), authorization);
  }
}

export async function listStudents(authorization: string): Promise<ToolResult> {
  return readCollection(authorization, "/v1/students");
}

export async function getStudent(authorization: string, id: string): Promise<ToolResult> {
  return readCollection(authorization, `/v1/students/${encodeURIComponent(id)}`);
}

export async function listParents(authorization: string): Promise<ToolResult> {
  return readCollection(authorization, "/v1/parents");
}

export async function getParent(authorization: string, id: string): Promise<ToolResult> {
  return readCollection(authorization, `/v1/parents/${encodeURIComponent(id)}`);
}

export async function listFamilies(authorization: string): Promise<ToolResult> {
  return readCollection(authorization, "/v1/families");
}

export async function getFamily(authorization: string, id: string): Promise<ToolResult> {
  return readCollection(authorization, `/v1/families/${encodeURIComponent(id)}`);
}

export async function listInvoices(authorization: string): Promise<ToolResult> {
  return readCollection(authorization, "/v1/invoices");
}

export async function listTransactions(authorization: string): Promise<ToolResult> {
  return readCollection(authorization, "/v1/transactions");
}

const addStudentInput = z
  .object({
    confirm,
    FirstName: z.string().trim().min(1).max(60),
    LastName: z.string().trim().min(1).max(60),
    FamilyID: familyId.optional().describe("Join this existing family. Do not also send Family."),
    Family: z
      .object({ FamilyName: z.string().min(1).optional() })
      .optional()
      .describe("Create a family as a side effect. FamilyName is optional. The server sends Adult: {}."),
    Status: status.optional(),
    Telephone: z
      .object({
        TelephoneNumber: z.string().min(1),
        TextingAllowed: z.boolean().optional(),
      })
      .optional(),
    SkillLevel: z.string().optional(),
    LocalSchool: z.string().optional(),
    Note: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasId = value.FamilyID !== undefined;
    const hasFamily = value.Family !== undefined;
    if (hasId === hasFamily) {
      ctx.addIssue({
        code: "custom",
        message: "Send exactly one of FamilyID (join a family) or Family (create a family).",
      });
    }
  });

export async function addStudent(
  authorization: string,
  input: z.infer<typeof addStudentInput>,
): Promise<ToolResult> {
  if (input.confirm !== true) return toolError("confirm must be true. Nothing was sent.");
  const body: Record<string, unknown> = {
    FirstName: input.FirstName,
    LastName: input.LastName,
  };
  if (input.Status) body.Status = input.Status;
  if (input.FamilyID) body.FamilyID = input.FamilyID;
  if (input.Family) {
    body.Family = input.Family;
    body.Adult = {};
  }
  if (input.Telephone) body.Telephone = input.Telephone;
  if (input.SkillLevel !== undefined) body.SkillLevel = input.SkillLevel;
  if (input.LocalSchool !== undefined) body.LocalSchool = input.LocalSchool;
  if (input.Note !== undefined) body.Note = input.Note;

  const result = await tutorbirdRequest({
    authorization,
    method: "POST",
    path: "/v1/students",
    body,
    retry429: false,
  });
  if (result.status < 200 || result.status >= 300) {
    return toolError(upstreamFailure("POST", "/v1/students", result, authorization), authorization);
  }
  return toolOk(
    {
      created: true,
      id: result.body,
      note: "Success is HTTP 200 and a JSON string id, not a 201 object. Nested email does not persist on create. Set EmailAddress with update_student. There is no delete; set Status to Inactive to retire a duplicate.",
    },
    authorization,
  );
}

const updateStudentInput = z
  .object({
    confirm,
    studentId,
    EmailAddress: z.string().email().optional().describe("Flat EmailAddress. Nested Email does not persist."),
    Status: status.optional().describe("Use Inactive to retire a record. There is no delete."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.EmailAddress === undefined && value.Status === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Send EmailAddress, Status, or both. Those are the confirmed PUT fields.",
      });
    }
  });

export async function updateStudent(
  authorization: string,
  input: z.infer<typeof updateStudentInput>,
): Promise<ToolResult> {
  if (input.confirm !== true) return toolError("confirm must be true. Nothing was sent.");
  const body: Record<string, unknown> = {};
  if (input.EmailAddress !== undefined) body.EmailAddress = input.EmailAddress;
  if (input.Status !== undefined) body.Status = input.Status;
  const path = `/v1/students/${encodeURIComponent(input.studentId)}`;
  const result = await tutorbirdRequest({ authorization, method: "PUT", path, body });
  if (result.status < 200 || result.status >= 300) {
    return toolError(upstreamFailure("PUT", path, result, authorization), authorization);
  }
  return toolOk({ updated: true, body: result.body }, authorization);
}

const addParentInput = z
  .object({
    confirm,
    FamilyID: familyId,
    FirstName: z.string().trim().min(1).max(60),
    LastName: z.string().trim().min(1).max(60),
  })
  .strict();

export async function addParent(
  authorization: string,
  input: z.infer<typeof addParentInput>,
): Promise<ToolResult> {
  if (input.confirm !== true) return toolError("confirm must be true. Nothing was sent.");
  const result = await tutorbirdRequest({
    authorization,
    method: "POST",
    path: "/v1/parents",
    body: {
      FamilyID: input.FamilyID,
      FirstName: input.FirstName,
      LastName: input.LastName,
    },
    retry429: false,
  });
  if (result.status < 200 || result.status >= 300) {
    return toolError(upstreamFailure("POST", "/v1/parents", result, authorization), authorization);
  }
  return toolOk(
    {
      created: true,
      id: result.body,
      note: "Success is HTTP 200 and a JSON string id. Email and mobile on the create body do not persist. Set email afterward with update_parent. POST /v1/families is 404.",
    },
    authorization,
  );
}

const updateParentInput = z
  .object({
    confirm,
    parentId,
    EmailAddress: z.string().email().describe("Flat EmailAddress. Mobile does not persist on this PUT."),
  })
  .strict();

export async function updateParent(
  authorization: string,
  input: z.infer<typeof updateParentInput>,
): Promise<ToolResult> {
  if (input.confirm !== true) return toolError("confirm must be true. Nothing was sent.");
  const path = `/v1/parents/${encodeURIComponent(input.parentId)}`;
  const result = await tutorbirdRequest({
    authorization,
    method: "PUT",
    path,
    body: { EmailAddress: input.EmailAddress },
  });
  if (result.status < 200 || result.status >= 300) {
    return toolError(upstreamFailure("PUT", path, result, authorization), authorization);
  }
  return toolOk({ updated: true, body: result.body }, authorization);
}

const updateFamilyNameInput = z
  .object({
    confirm,
    familyId,
    FamilyName: z.string().trim().min(1),
  })
  .strict();

export async function updateFamilyName(
  authorization: string,
  input: z.infer<typeof updateFamilyNameInput>,
): Promise<ToolResult> {
  if (input.confirm !== true) return toolError("confirm must be true. Nothing was sent.");
  const path = `/v1/families/${encodeURIComponent(input.familyId)}`;
  const result = await tutorbirdRequest({
    authorization,
    method: "PUT",
    path,
    body: { FamilyName: input.FamilyName },
  });
  if (result.status < 200 || result.status >= 300) {
    return toolError(upstreamFailure("PUT", path, result, authorization), authorization);
  }
  return toolOk(
    {
      updated: true,
      warning: "The stored name is the previous name, then '; ', then the submitted text. This was not a replace.",
      body: result.body,
    },
    authorization,
  );
}

const SUMMARY_KEYS = [
  "ID",
  "Description",
  "Reference",
  "Type",
  "TransactionType",
  "Amount",
  "Payment",
  "FamilyID",
  "StudentID",
  "AccountBalance",
  "Date",
  "Timestamp",
  "Method",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function summarizeTransaction(item: Record<string, unknown>): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) {
    if (key in item) summary[key] = item[key];
  }
  return summary;
}

export type TransactionScan =
  | { kind: "clear" }
  | { kind: "duplicate"; matches: Record<string, unknown>[] }
  | { kind: "incomplete"; total: number | null; returned: number };

/** Scan a documented GET /v1/transactions payload for an exact Description or Reference match. */
export function scanTransactions(body: unknown, reference: string): TransactionScan {
  const needle = reference.trim();
  let items: unknown[] | null = null;
  let total: number | null = null;
  if (Array.isArray(body)) {
    items = body;
    total = body.length;
  } else if (isRecord(body) && Array.isArray(body.ItemSubset)) {
    items = body.ItemSubset;
    total = typeof body.TotalItemCount === "number" ? body.TotalItemCount : null;
  } else {
    return { kind: "incomplete", total: null, returned: 0 };
  }

  if (total !== null && total !== items.length) {
    return { kind: "incomplete", total, returned: items.length };
  }

  const matches: Record<string, unknown>[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const description = typeof item.Description === "string" ? item.Description.trim() : "";
    const extra = typeof item.Reference === "string" ? item.Reference.trim() : "";
    if ((description !== "" && description === needle) || (extra !== "" && extra === needle)) {
      matches.push(summarizeTransaction(item));
    }
  }
  if (matches.length > 0) return { kind: "duplicate", matches };
  return { kind: "clear" };
}

const addPaymentInput = z
  .object({
    confirm,
    reference: z
      .string()
      .trim()
      .min(1)
      .describe("Unique text stored as Description. GET /v1/transactions is checked for this text before any POST."),
    FamilyID: familyId,
    StudentID: studentId.describe("Required. An empty StudentID is HTTP 400 UnparseableID."),
    Amount: z.number().finite(),
    Timestamp: localTimestamp,
    PaymentMethod: z.string().min(1).optional().describe("Accepted on the write and dropped on read-back."),
    InvoiceIDsToBeMarkedPaid: z.array(z.string()).optional(),
  })
  .strict();

export async function addPayment(
  authorization: string,
  input: z.infer<typeof addPaymentInput>,
): Promise<ToolResult> {
  if (input.confirm !== true) return toolError("confirm must be true. Nothing was sent.");
  const reference = input.reference.trim();
  const body: Record<string, unknown> = {
    TransactionType: "Payment",
    FamilyID: input.FamilyID,
    StudentID: input.StudentID,
    Amount: input.Amount,
    Description: reference,
    Timestamp: input.Timestamp,
    InvoiceIDsToBeMarkedPaid: input.InvoiceIDsToBeMarkedPaid ?? [],
  };
  if (input.PaymentMethod) body.PaymentMethod = input.PaymentMethod;

  for (let attempt = 0; attempt < 3; attempt++) {
    const list = await tutorbirdRequest({
      authorization,
      method: "GET",
      path: "/v1/transactions",
    });
    if (list.status === 429) {
      return toolError(`${upstreamFailure("GET", "/v1/transactions", list, authorization)} Nothing was posted.`, authorization);
    }
    if (list.status < 200 || list.status >= 300) {
      return toolError(`${upstreamFailure("GET", "/v1/transactions", list, authorization)} Nothing was posted.`, authorization);
    }

    const scan = scanTransactions(list.body, reference);
    if (scan.kind === "duplicate") {
      return toolOk(
        {
          posted: false,
          reason: "A transaction with this Description already exists. Nothing was posted.",
          matches: scan.matches,
        },
        authorization,
      );
    }
    if (scan.kind === "incomplete") {
      return toolError(
        {
          posted: false,
          reason:
            "GET /v1/transactions did not return a complete list, so the duplicate check cannot be trusted. Nothing was posted.",
          totalItemCount: scan.total,
          returned: scan.returned,
        },
        authorization,
      );
    }

    const posted = await tutorbirdRequest({
      authorization,
      method: "POST",
      path: "/v1/transactions",
      body,
      retry429: false,
    });
    if (posted.status === 429) {
      await clientDeps.sleep(backoffMs(attempt, posted.retryAfter));
      continue;
    }
    if (posted.status < 200 || posted.status >= 300) {
      return toolError(upstreamFailure("POST", "/v1/transactions", posted, authorization), authorization);
    }
    return toolOk({ posted: true, id: posted.body }, authorization);
  }

  return toolError(
    "TutorBird kept returning HTTP 429 on POST /v1/transactions. Back off before retrying. Nothing further was posted.",
    authorization,
  );
}

/**
 * Confirmed tools only.
 * Omitted: GET /v1/events/{eventId} and GET /v1/students/{studentId}/attendance
 * are x-path-status inferred. POST /v1/payments is x-path-status wrong (404).
 * POST /v1/families is 404. PATCH /v1/students/{id} is 405. GET /v1 returns 500.
 */
export function registerTutorBirdTools(server: McpServer): void {
  server.registerTool(
    "list_students",
    {
      title: "List students",
      description:
        "GET /v1/students. Returns the full list as ItemSubset and TotalItemCount. A search query is ignored, so this tool takes no filters. Do not page in a loop.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (_args, ctx) => guarded(ctx, listStudents),
  );

  server.registerTool(
    "get_student",
    {
      title: "Get student",
      description: "GET /v1/students/{studentId}. Use this when you already have an sdt_ id. The list route does not filter.",
      inputSchema: z.object({ studentId }).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => getStudent(authorization, args.studentId)),
  );

  server.registerTool(
    "list_parents",
    {
      title: "List parents",
      description:
        "GET /v1/parents. Identifiers use the prt_ prefix. The list envelope was not recorded, and family or search filters were not confirmed, so this tool takes no filters.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (_args, ctx) => guarded(ctx, listParents),
  );

  server.registerTool(
    "get_parent",
    {
      title: "Get parent",
      description: "GET /v1/parents/{parentId}.",
      inputSchema: z.object({ parentId }).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => getParent(authorization, args.parentId)),
  );

  server.registerTool(
    "list_families",
    {
      title: "List families",
      description:
        "GET /v1/families. Nested Students and Parents on each family come back empty. Read people from the student and parent tools.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (_args, ctx) => guarded(ctx, listFamilies),
  );

  server.registerTool(
    "get_family",
    {
      title: "Get family",
      description:
        "GET /v1/families/{familyId}. Nested Students and Parents come back empty. family.Balance reads 0; use transaction AccountBalance.",
      inputSchema: z.object({ familyId }).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => getFamily(authorization, args.familyId)),
  );

  server.registerTool(
    "list_invoices",
    {
      title: "List invoices",
      description:
        "GET /v1/invoices. The README lists this as a confirmed read. The OpenAPI file has no invoice schema, so the raw JSON is returned. This tool takes no filters.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (_args, ctx) => guarded(ctx, listInvoices),
  );

  server.registerTool(
    "list_transactions",
    {
      title: "List transactions",
      description:
        "GET /v1/transactions. Confirmed read. AccountBalance is the running balance and negative means the family owes. PaymentMethod reads back null. This tool takes no filters and does not page.",
      inputSchema: z.object({}).strict(),
      annotations: READ_ANNOTATIONS,
    },
    async (_args, ctx) => guarded(ctx, listTransactions),
  );

  server.registerTool(
    "add_student",
    {
      title: "Add student",
      description: `${LIVE_WRITE} POST /v1/students. Requires FirstName, LastName, and exactly one of FamilyID or Family. A new family also sends Adult: {}. Success is HTTP 200 and a bare sdt_ string. Email is not a create field. There is no delete.`,
      inputSchema: addStudentInput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => addStudent(authorization, args)),
  );

  server.registerTool(
    "update_student",
    {
      title: "Update student",
      description: `${LIVE_WRITE} PUT /v1/students/{studentId}. Partial body. Confirmed fields are flat EmailAddress and Status. Success is HTTP 200 and JSON true. PATCH is 405 and is not called. Set Status to Inactive to retire a duplicate.`,
      inputSchema: updateStudentInput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => updateStudent(authorization, args)),
  );

  server.registerTool(
    "add_parent",
    {
      title: "Add parent",
      description: `${LIVE_WRITE} POST /v1/parents on an existing FamilyID. Success is HTTP 200 and a bare prt_ string. Email and mobile do not persist on create. POST /v1/families is 404 and is not called.`,
      inputSchema: addParentInput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => addParent(authorization, args)),
  );

  server.registerTool(
    "update_parent",
    {
      title: "Update parent",
      description: `${LIVE_WRITE} PUT /v1/parents/{parentId}. Sets flat EmailAddress. Mobile does not persist, and IsPreferredInvoiceRecipient did not persist on PUT. The response body was not recorded beyond success.`,
      inputSchema: updateParentInput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => updateParent(authorization, args)),
  );

  server.registerTool(
    "update_family_name",
    {
      title: "Append family name",
      description: `${LIVE_WRITE} PUT /v1/families/{familyId} appends "; " and FamilyName to the current name. It does not replace the name. Do not use it as a rename.`,
      inputSchema: updateFamilyNameInput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => updateFamilyName(authorization, args)),
  );

  server.registerTool(
    "add_payment",
    {
      title: "Add payment",
      description: `${LIVE_WRITE} POST /v1/transactions with TransactionType Payment. The repo has no transactions search route, so this first calls the documented GET /v1/transactions and will not post if Description already equals reference, or if that list is incomplete. reference is sent as Description. Success is HTTP 200 and a bare rcv_ string. POST /v1/payments is 404 and is not called. StudentID is required. PaymentMethod is dropped on read-back.`,
      inputSchema: addPaymentInput,
      annotations: WRITE_ANNOTATIONS,
    },
    async (args, ctx) => guarded(ctx, (authorization) => addPayment(authorization, args)),
  );
}
