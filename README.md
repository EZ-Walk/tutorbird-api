# TutorBird API

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
npx --yes @redocly/cli lint openapi/tutorbird.openapi.yaml
python3 -m json.tool postman/TutorBird.postman_collection.json >/dev/null
```

## Sources

- [How do I integrate with Zapier?](https://support.tutorbird.com/en/articles/963-how-do-i-integrate-with-zapier)
- [What can I do with TutorBird & Zapier?](https://support.tutorbird.com/en/articles/965-what-can-i-do-with-tutorbird-zapier)
- [Zapier Triggers](https://support.tutorbird.com/en/articles/1062-zapier-triggers)
- [Zapier Actions](https://support.tutorbird.com/en/articles/1063-zapier-actions)
- [Zapier app listing](https://zapier.com/apps/tutorbird/integrations)
