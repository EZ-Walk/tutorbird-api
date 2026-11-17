/** Strip bearer tokens from anything we might log or return. */
export function redactSecrets(text: string, authorization?: string): string {
  let out = text.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
  if (authorization) {
    const token = authorization.replace(/^Bearer\s+/i, "").trim();
    if (token.length >= 8) {
      out = out.split(token).join("[redacted]");
    }
  }
  return out;
}
