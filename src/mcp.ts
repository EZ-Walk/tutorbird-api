import { createMcpHandler } from "mcp-handler";
import { registerTutorBirdTools } from "./tools";

export const mcpHandler = createMcpHandler(
  (server) => {
    registerTutorBirdTools(server);
  },
  {
    serverInfo: { name: "tutorbird", version: "0.1.0" },
    instructions:
      "Unofficial TutorBird proxy. Read tools are listed first. Write tools change the live account immediately and permanently. There is no undo and no test environment. Do not call a write tool unless a person has approved that exact change. There is no delete. GET /v1 is not a health check.",
    verboseLogs: false,
    telemetry: false,
  },
);
