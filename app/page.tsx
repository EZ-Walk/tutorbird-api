export default function Home() {
  return (
    <main>
      <h1>TutorBird MCP</h1>
      <p>
        Unofficial Streamable HTTP proxy for the TutorBird API. Point an MCP client at <code>/mcp</code> and
        send <code>Authorization: Bearer</code> on every request. This server does not store an API key.
      </p>
    </main>
  );
}
