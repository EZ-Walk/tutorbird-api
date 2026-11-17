# TutorBird API (unofficial)

> **Disclaimer:** This is an unofficial, reverse-engineered description of the TutorBird HTTP API. It is not affiliated with, endorsed by, or supported by TutorBird. Use it only on your own account, at your own risk. Writes are permanent: there is no delete and no dry-run mode.

TutorBird publishes no official OpenAPI document. The surface is Zapier-shaped: TutorBird exposes API keys for its Zapier app, and the paths below were confirmed by calling the API directly.

## Quick reference

- **Base URL:** `https://api.tutorbird.com/v1`
- **Auth:** `Authorization: Bearer <key>` (key from Business Settings → Integrations; writes need a Read & Write key)
- **Lists** return `{"ItemSubset": [...], "TotalItemCount": n}` with every record at once. `skip`/`take` are ignored, so do **not** paginate in a loop (it repeats forever).

### Confirmed reads

`GET /parents`, `GET /students`, `GET /families`, `GET /invoices`, `GET /transactions` (plus `/{id}` for parents, students, families).

### Confirmed write: add a payment

`POST /v1/transactions`

```json
{
  "TransactionType": "Payment",
  "FamilyID": "fml_XXXX",
  "StudentID": "sdt_XXXX",
  "Amount": 0.01,
  "Description": "...",
  "PaymentMethod": "Venmo",
  "Timestamp": "YYYY-MM-DD",
  "InvoiceIDsToBeMarkedPaid": []
}
```

Returns **HTTP 200** with a bare JSON string ID such as `"rcv_..."`, not a 201 object. Validated on 2026-10-29 with an API key and a read-back of `/transactions` (type, family, student, amount, and running balance all matched).

### Known quirks

- `POST /payments` (listed in older specs and inferred from Zapier) returns **404**. It is marked `x-path-status: wrong` in the spec. Use `POST /transactions`.
- An empty-body `POST /transactions` returns **500**, not a validation error.
- `PaymentMethod` is silently dropped (reads back null).
- `AccountBalance` on each transaction is the real running balance; **negative means the family owes**. `family.Balance` reads 0.
- No dry-run mode.
- No delete. Set records `Status: Inactive` instead.
- Student search query params are ignored; the full list comes back.
- `GET /v1` returns 500. It is not a health check.
- Email does not stick on create (set flat `EmailAddress` with a PUT).
- Parent mobile does not persist.
- Family rename (`PUT FamilyName`) appends instead of replacing.
- Nested family members (`Students`, `Parents`) come back empty.
- `OPTIONS` returns 200 for every path, so it proves nothing about a route.

### Bulk balance reset

To zero a family's balance, take the AccountBalance of that family's latest transaction (negative = owes) and POST a Payment to /v1/transactions for -AccountBalance. Writes are permanent with no delete or dry run, so build a dry-run list first and test on your own family. 

Results (2026-10-29, run once at the account owner's request): 66 families had a negative latest balance. 65 were paid one at a time, 1.5 s apart; every call returned HTTP 200 with a bare `rcv_` ID. A fresh `GET /v1/transactions` read-back showed each paid family's latest AccountBalance at exactly 0. One failed: a family with no student on record got `400 UnparseableID` (an empty `StudentID` is rejected, so treat StudentID as required). Quirks seen: `PaymentMethod` is still dropped on read-back, and the family `Balance` field stays 0 regardless, so use the transaction running balance.

## Connecting an MCP client

Claude Desktop and similar clients cannot call this REST API directly. They need an MCP server that exposes calls as tools. This repo ships a thin Streamable HTTP proxy at `/mcp`. It forwards to `https://api.tutorbird.com`, stores no API key, and passes the caller's `Authorization` header through.

**Server URL:** `https://tutorbird-api.vercel.app/mcp`

That host is the Vercel project `tutorbird-api`. Leave Vercel Authentication off for this project, or MCP clients cannot connect. TutorBird auth is the bearer token on `/mcp`. Locally, `npm run dev` serves `http://localhost:3000/mcp`. `npm test` mocks TutorBird and does not call it.

### Client config

Use one `mcpServers` entry in Claude Desktop (`claude_desktop_config.json`) or in `mcp.json`. Keep the key in that local file or in `TUTORBIRD_API_KEY`. Do not commit it.

```json
{
  "mcpServers": {
    "tutorbird": {
      "url": "https://tutorbird-api.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer <TUTORBIRD_API_KEY>"
      }
    }
  }
}
```

Clients that cannot send headers on a remote server can use `mcp-remote`:

```json
{
  "mcpServers": {
    "tutorbird": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://tutorbird-api.vercel.app/mcp",
        "--header",
        "Authorization: Bearer <TUTORBIRD_API_KEY>"
      ]
    }
  }
}
```

Zapier MCP is the other hosted path: https://zapier.com/mcp/tutorbird. TutorBird has said an official MCP is coming. This proxy is the unofficial server until then.

### Auth and requests

- The proxy requires `Authorization: Bearer <key>` and sends that header to TutorBird unchanged. Anything else is HTTP 401. The key is not read from the server environment and is not logged.
- Keys in these notes are **Read-Only** or **Read & Write**. TutorBird's beta Swagger calls the write key full-access. A write key changes the live account. The account owner should create it under **Business Settings → Integrations** (a multi-tutor account needs the Administrator privilege) and keep it.
- Every upstream request sends `User-Agent`. The default is `SteelesScholars-Assistant/1.0`. Set `TUTORBIRD_USER_AGENT` on the server to override it.
- Date-times are school-local, with no `Z` and no numeric offset. This repo records them as `yyyy-mm-dd hh:mm:ss`. The confirmed payment example uses a date-only `Timestamp` (`YYYY-MM-DD`). The beta Swagger describes `2024-01-15T14:30:00` in the school timezone. Do not send UTC.
- Lists return every record at once. `skip`/`take` are ignored, so do not page in a loop. The proxy backs off and retries reads and PUTs on HTTP 429. It does not blindly retry a POST. `add_payment` lists transactions again before each attempt.

### Tools

Read tools are registered first. Each write tool says the change is live, immediate, and permanent, with no undo. There is no delete tool and no test environment. Approve a write before the client calls it. `confirm` must be `true` or the proxy does not send the write.

| Tool | Method and path |
| --- | --- |
| `list_students` | `GET /v1/students` |
| `get_student` | `GET /v1/students/{studentId}` |
| `list_parents` | `GET /v1/parents` |
| `get_parent` | `GET /v1/parents/{parentId}` |
| `list_families` | `GET /v1/families` |
| `get_family` | `GET /v1/families/{familyId}` |
| `list_invoices` | `GET /v1/invoices` |
| `list_transactions` | `GET /v1/transactions` |
| `add_student` | `POST /v1/students` |
| `update_student` | `PUT /v1/students/{studentId}` |
| `add_parent` | `POST /v1/parents` |
| `update_parent` | `PUT /v1/parents/{parentId}` |
| `update_family_name` | `PUT /v1/families/{familyId}` (appends; not a rename) |
| `add_payment` | `POST /v1/transactions` after `GET /v1/transactions` |

`add_payment` sends `TransactionType` `Payment` and requires `StudentID`. The repo does not document a transactions search route, so the tool calls `GET /v1/transactions`, treats `reference` as `Description`, and does not post when that description is already present or the list is incomplete. `POST /v1/payments` is not called (404, `x-path-status: wrong`).

Not exposed: `GET /v1/events/{eventId}` and `GET /v1/students/{studentId}/attendance` are `inferred`. Calendar search, attendance create, cancel, reschedule, and event replacement are not confirmed in this repo.

### Caveats

- TutorBird publishes no official OpenAPI document. `https://api.tutorbird.com/v1/swagger` is a beta Swagger UI, and its description says the API is not officially supported. This proxy follows the confirmed paths in this repo, not the rest of that Swagger file.
- No delete. Set a student `Status` to `Inactive`.
- Nested email does not stick on create. Set flat `EmailAddress` with PUT.
- Parent mobile does not persist. `IsPreferredInvoiceRecipient` did not persist on parent PUT. That PUT's response body was not recorded beyond success.
- `PUT` `FamilyName` appends `"; "` and the new text. It does not replace the name.
- Nested family `Students` and `Parents` come back empty.
- Student search filters are ignored.
- `GET /v1` returns 500. It is not a health check and it is not a tool.
- `PaymentMethod` is dropped on read-back. `AccountBalance` is the running balance (negative means the family owes). `family.Balance` reads 0. An empty `StudentID` on a payment is `400 UnparseableID`.
- Writes are permanent. There is no dry-run.

---

## Detailed notes

Unofficial OpenAPI specification and Postman collection for the [TutorBird](https://www.tutorbird.com/) integration API.

TutorBird lets an account owner create an API key and connect it to Zapier. The help center documents the triggers, actions, identifier prefixes, and field formats. TutorBird does not publish HTTP paths or an OpenAPI document. This repository records the published contract and maps each operation onto a REST path so the collection can be imported and tried.

This project is not affiliated with TutorBird. TutorBird is a trademark of its owner.

## What is confirmed

Confirmed from TutorBird's help center and the public Zapier app listing (retrieved 2026-10-03):

- API keys are created under **Business Settings → Integrations → + Add API Key**.
- A key is **Read-Only** or **Read & Write**, and it is shown once.
- Multi-tutor accounts need the Administrator privilege to create a key.
- Zapier writes: Add Student, Update Student (including status), Add Payment.
- Zapier reads: Find Student, Find Parent, Find All Parents, Find Event, Find Attendance Records.
- Events: New Student, Student Updated, Attendance Taken, Student Added to Event, New Invoice, Payment Added, New Email, New SMS.
- Identifier prefixes: `sdt_` student, `fml_` family, `prt_` parent, `evt_` event, `atn_` attendance, `tch_` teacher, `inv_` invoice, `rcv_` payment created by Add Payment, `csh_` payment on the Payment Added trigger.
- Student type in the help center is `Child` or `Adult`. Status is `Active`, `Inactive`, `Waiting`, `Lead`, or `Trial`.
- Dates are `yyyy-mm-dd`. Date-times are `yyyy-mm-dd hh:mm:ss`.

Confirmed by calling `https://api.tutorbird.com` with `Authorization: Bearer <apiKey>` on 2026-10-08. Wire names are PascalCase (`FirstName`, `FamilyID`, `ItemSubset`). These operations are marked `x-path-status: confirmed` in the spec. Events, attendance, payments, and webhooks were not called and stay `inferred`.

- `GET /v1/students` returns `{"ItemSubset": [...], "TotalItemCount": n}`. A search query string is ignored; the route returns the full list.
- `GET /v1/students/{studentId}` returns one student (`sdt_`).
- `GET /v1/parents` and `GET /v1/parents/{parentId}` (`prt_`).
- `GET /v1/families` and `GET /v1/families/{familyId}` (`fml_`). Nested `Students` and `Parents` arrays on the family payload come back empty. Use the student and parent routes for those records.
- `GET /v1` (the bare version root) can return HTTP 500 even when the resource routes work. Do not use it as a health check.
- `POST /v1/students` takes JSON. Success is HTTP 200 and a JSON string of the new id, such as `"sdt_..."`. Not 201, and not an object. There is no delete. Retire a duplicate with `Status` `Inactive`.
- Create requires `FirstName` and `LastName` (non-empty, max 60) and exactly one of `Family` or `FamilyID`.
- Join an existing family with `FamilyID` (`fml_...`) and do not send `Family`.
- Create a family only as a side effect of that student post: send `Family` as an object (`FamilyName` is optional) and `"Adult": {}`. Omitting `Adult`, or sending a populated `Adult`, returns 400 `StudentInputItem.Adult: Must be null for new family`. The empty object is what the server accepts for a child on a new family. `POST /v1/families` is 404.
- Fields that persist on student create: `Status`, `Telephone` as `{"TelephoneNumber": "...", "TextingAllowed": true}`, `SkillLevel`, `LocalSchool`, and `Note`. Nested `Email` does not persist on create.
- `PUT /v1/students/{studentId}` accepts a partial body, returns HTTP 200 and JSON `true`. `PATCH` returns 405. Email persists only as flat `{"EmailAddress": "name@example.com"}`. Nested `Email`, `email`, and `StudentEmail` do not stick. Status updates with `{"Status": "Inactive"}`.
- `POST /v1/parents` requires an existing `FamilyID`. Success is HTTP 200 and a JSON string of the new `prt_` id. `FirstName` and `LastName` persist. Nested `Email` and `MobileTelephone` on the create body do not.
- `PUT /v1/parents/{parentId}` stores email as flat `EmailAddress`. Parent mobile does not persist via `MobileTelephone`, `TelephoneNumber`, `PhoneNumber`, `MobileTelephoneNumber`, or `MobilePhone` (known gap). `IsPreferredInvoiceRecipient` did not persist on PUT.
- `PUT /v1/families/{familyId}` with `{"FamilyName": "..."}` appends `"; "` and the new text to the current name. It does not replace it. On create, `FamilyName` is combined with the names of the people added. Do not treat rename as a safe replace.

Email and SMS events are listed by Zapier without fields. Their schemas accept any JSON object.

## Layout

| Path | Purpose |
| --- | --- |
| `app/mcp/route.ts` | Streamable HTTP MCP proxy (`/mcp`) |
| `src/` | TutorBird client, tool registration, auth gate |
| `vercel.json` | Vercel project config |
| `openapi/tutorbird.openapi.yaml` | OpenAPI 3.1 specification |
| `postman/TutorBird.postman_collection.json` | Postman Collection v2.1 |
| `postman/TutorBird.local.postman_environment.json` | Environment with `baseUrl`, `apiKey`, and sample ids |
| `examples/webhooks/` | Sample event payloads |

## Use the collection

1. In TutorBird, open **Business Settings → Integrations → + Add API Key**. Copy the key before you close the dialog.
2. In Postman, import both files in `postman/`.
3. Select the **TutorBird** environment and paste the key into `apiKey`. Leave the committed example value empty.
4. Call a confirmed resource route, such as `GET /v1/students`. Do not use `GET /v1` as a health check. That URL can return HTTP 500 while students, parents, and families still respond.
5. Student search text is ignored. `GET /v1/students` returns the full list in `ItemSubset`. Fetch one student with `GET /v1/students/{studentId}`.
6. Create a student with `POST /v1/students` and the PascalCase body in **Add student (child)**. Expect HTTP 200 and a JSON string id (`sdt_...`). Update with `PUT`, not `PATCH`. Set email as flat `EmailAddress`. Set `Status` to `Inactive` when you need to retire a duplicate. There is no delete.
7. Add a parent with `POST /v1/parents` only after a family id exists. A new family comes from the student create (`Family` plus `"Adult": {}`), not from `POST /v1/families`.

The collection sends the key as `Authorization: Bearer <apiKey>`.

Calendar, payment, and webhook requests are still inferred. A 404 on those paths means the path has not been confirmed.

Webhook sample requests post to `webhookSinkUrl`, which defaults to `https://httpbin.org/post`. Point it at your own receiver to try the payloads. Those requests do not call TutorBird and do not send your API key.

You can also import `openapi/tutorbird.openapi.yaml` through Postman's OpenAPI importer.

## Check the spec

```bash
npm test
npx --yes @redocly/cli lint openapi/tutorbird.openapi.yaml
python3 -m json.tool postman/TutorBird.postman_collection.json >/dev/null
```

`npm test` uses a mocked upstream. It does not call `api.tutorbird.com`.

## Sources

- [How do I integrate with Zapier?](https://support.tutorbird.com/en/articles/963-how-do-i-integrate-with-zapier)
- [What can I do with TutorBird & Zapier?](https://support.tutorbird.com/en/articles/965-what-can-i-do-with-tutorbird-zapier)
- [Zapier Triggers](https://support.tutorbird.com/en/articles/1062-zapier-triggers)
- [Zapier Actions](https://support.tutorbird.com/en/articles/1063-zapier-actions)
- [Zapier app listing](https://zapier.com/apps/tutorbird/integrations)
