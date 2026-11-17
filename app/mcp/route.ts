import { handleMcp } from "../../src/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = handleMcp;
export const POST = handleMcp;
