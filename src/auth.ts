import { redactSecrets } from "./redact";

const BEARER = /^Bearer\s+\S+$/i;

export function isBearer(value: string): boolean {
  return BEARER.test(value.trim());
}

/** The incoming Authorization header, unchanged except for surrounding whitespace. */
export function bearerHeader(request: Request): string | null {
  const value = request.headers.get("authorization");
  if (!value) return null;
  const trimmed = value.trim();
  if (!isBearer(trimmed)) return null;
  return trimmed;
}

export function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "Authorization: Bearer token is required" }),
    {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer",
        "cache-control": "no-store",
      },
    },
  );
}

export function safeErrorText(error: unknown, authorization?: string): string {
  const message = error instanceof Error ? error.message : "Request failed";
  return redactSecrets(message, authorization);
}
