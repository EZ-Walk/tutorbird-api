import { redactSecrets } from "./redact";
import { isBearer } from "./auth";

export const TUTORBIRD_ORIGIN = "https://api.tutorbird.com";
export const DEFAULT_USER_AGENT = "SteelesScholars-Assistant/1.0";

const ALLOWED_PATHS = [
  /^\/v1\/students$/,
  /^\/v1\/students\/[^/?#]+$/,
  /^\/v1\/parents$/,
  /^\/v1\/parents\/[^/?#]+$/,
  /^\/v1\/families$/,
  /^\/v1\/families\/[^/?#]+$/,
  /^\/v1\/invoices$/,
  /^\/v1\/transactions$/,
];

export type ClientDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export const clientDeps: ClientDeps = {
  fetch: globalThis.fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export type UpstreamResult = {
  status: number;
  body: unknown;
  text: string;
  retryAfter: string | null;
};

export function userAgent(): string {
  const configured = process.env.TUTORBIRD_USER_AGENT?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_USER_AGENT;
}

export function assertAllowedPath(path: string): void {
  if (!ALLOWED_PATHS.some((pattern) => pattern.test(path))) {
    throw new Error(`Refusing undocumented TutorBird path: ${path}`);
  }
}

export function backoffMs(attempt: number, retryAfter: string | null, now = clientDeps.now()): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000);
    }
    const when = Date.parse(retryAfter);
    if (!Number.isNaN(when)) {
      return Math.min(Math.max(when - now, 0), 10_000);
    }
  }
  return Math.min(500 * 2 ** attempt, 8_000);
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function tutorbirdRequest(options: {
  authorization: string;
  method: "GET" | "POST" | "PUT";
  path: string;
  body?: unknown;
  retry429?: boolean;
}): Promise<UpstreamResult> {
  const { authorization, method, path } = options;
  if (!isBearer(authorization)) {
    throw new Error("Refusing to call TutorBird without a Bearer authorization header.");
  }
  assertAllowedPath(path);
  if (process.env.TUTORBIRD_FORBID_NETWORK === "1" && clientDeps.fetch === globalThis.fetch) {
    throw new Error("Refusing to call TutorBird because TUTORBIRD_FORBID_NETWORK=1");
  }

  const retry429 = options.retry429 ?? method !== "POST";
  const headers = new Headers();
  headers.set("Authorization", authorization);
  headers.set("User-Agent", userAgent());
  headers.set("Accept", "application/json");
  if (options.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }

  let attempt = 0;
  while (true) {
    let response: Response;
    try {
      response = await clientDeps.fetch(`${TUTORBIRD_ORIGIN}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        redirect: "manual",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "network error";
      throw new Error(redactSecrets(`TutorBird ${method} ${path} failed: ${message}`, authorization));
    }

    const text = await response.text();
    const result: UpstreamResult = {
      status: response.status,
      text,
      body: parseBody(text),
      retryAfter: response.headers.get("retry-after"),
    };

    const redirected = response.status >= 300 && response.status < 400;
    if (redirected) {
      console.error(`TutorBird ${method} ${path} returned HTTP ${response.status}; redirect not followed`);
      return result;
    }

    if (result.status === 429 && retry429 && attempt < 3) {
      await clientDeps.sleep(backoffMs(attempt, result.retryAfter));
      attempt += 1;
      continue;
    }

    if (result.status < 200 || result.status >= 300) {
      console.error(`TutorBird ${method} ${path} returned HTTP ${result.status}`);
    }
    return result;
  }
}
