import { bearerHeader, unauthorized } from "./auth";
import { mcpHandler } from "./mcp";
import { requestAuth } from "./request-context";

export async function handleMcp(request: Request): Promise<Response> {
  const authorization = bearerHeader(request);
  if (!authorization) return unauthorized();

  const response = await requestAuth.run({ authorization }, () => mcpHandler(request));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
