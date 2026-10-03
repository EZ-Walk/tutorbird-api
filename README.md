# TutorBird API

Unofficial OpenAPI specification and Postman collection for the [TutorBird](https://www.tutorbird.com/) integration API.

TutorBird lets an account owner create an API key and connect it to Zapier. The help center documents the triggers, actions, identifier prefixes, and field formats. TutorBird does not publish HTTP paths or an OpenAPI document. This repository records the published contract and maps each operation onto a REST path so the collection can be imported and tried.

This project is not affiliated with TutorBird. TutorBird is a trademark of its owner.

## What is confirmed

Confirmed from TutorBird's help center and the public Zapier app listing (retrieved 2026-10-03):

- API keys are created under **Business Settings → Integrations → + Add API Key**.
- A key is **Read-Only** or **Read & Write**, and it is shown once.
- Multi-tutor accounts need the Administrator privilege to create a key.
- Write operations: Add Student, Update Student (including status), Add Payment.
- Read operations: Find Student, Find Parent, Find All Parents, Find Event, Find Attendance Records.
- Events: New Student, Student Updated, Attendance Taken, Student Added to Event, New Invoice, Payment Added, New Email, New SMS.
- Identifier prefixes: `sdt_` student, `fml_` family, `prt_` parent, `evt_` event, `atn_` attendance, `tch_` teacher, `inv_` invoice, `rcv_` payment created by Add Payment, `csh_` payment on the Payment Added trigger.
- Student type is `Child` or `Adult`. Status is `Active`, `Inactive`, `Waiting`, `Lead`, or `Trial`.
- Dates are `yyyy-mm-dd`. Date-times are `yyyy-mm-dd hh:mm:ss`.

`https://api.tutorbird.com` is the public API host. `GET /v1` is a real route. Resource paths in the spec (`POST /students`, `GET /events/{eventId}`, and the rest) are a community mapping. Each operation is marked `x-path-status: inferred`. A 404 means TutorBird has not confirmed that path.

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
3. Select the **TutorBird** environment and paste the key into `apiKey`.
4. Run a find request with a real `sdt_` or `evt_` id from your account.

The collection sends the key as `Authorization: Bearer <apiKey>`.

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
