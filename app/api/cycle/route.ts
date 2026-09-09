import { timingSafeEqual } from "node:crypto";
import { runScenario, SCENARIOS, type ScenarioId } from "@/lib/agent/demo";
import { summarize } from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 6;
const hits: number[] = [];

function authorised(request: Request): boolean {
  const expected = process.env.RECKON_DEMO_KEY;
  if (!expected) return false;

  const url = new URL(request.url);
  const supplied = request.headers.get("x-demo-key") ?? url.searchParams.get("key") ?? "";

  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function rateLimited(): boolean {
  const now = Date.now();
  while (hits.length > 0 && now - hits[0] > WINDOW_MS) hits.shift();
  if (hits.length >= MAX_PER_WINDOW) return true;
  hits.push(now);
  return false;
}

export async function POST(request: Request) {
  if (!authorised(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }
  if (rateLimited()) {
    return Response.json({ error: "too many runs, wait a minute" }, { status: 429 });
  }

  let body: { scenario?: string };
  try {
    body = (await request.json()) as { scenario?: string };
  } catch {
    body = {};
  }

  const scenario = body.scenario as ScenarioId | undefined;
  if (!scenario || !(scenario in SCENARIOS)) {
    return Response.json(
      { error: "unknown scenario", allowed: Object.keys(SCENARIOS) },
      { status: 400 }
    );
  }

  try {
    const receipt = await runScenario(scenario);
    return Response.json({ id: receipt.id, summary: summarize(receipt), receipt });
  } catch (error) {
    return Response.json(
      { error: String((error as Error).message).split("\n")[0].slice(0, 200) },
      { status: 500 }
    );
  }
}
