import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { formatUnits, type Address } from "viem";
import { z } from "zod/v4";
import { describeTerms, type Mandate } from "@/lib/mandate/schema";
import type { Portfolio, ProposedAction, TokenRisk, VenueId } from "@/lib/types";

export class PlannerError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(`[planner] ${message}`);
    this.name = "PlannerError";
  }
}

export interface Candidate {
  symbol: string;
  token: Address;
  risk: TokenRisk | null;
  note?: string;
}

export interface PlanInput {
  mandate: Mandate;
  portfolio: Portfolio;
  candidates: Candidate[];
  venue: VenueId;
  signals?: string[];
  model?: string;
}

const planSchema = z.object({
  action: z.enum(["buy", "sell", "none"]),
  symbol: z.string(),
  amountUsd: z.number(),
  rationale: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export type Plan = z.infer<typeof planSchema>;

export interface PlanResult {
  plan: Plan;
  proposal: ProposedAction | null;
  model: string;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function describePortfolio(portfolio: Portfolio): string {
  if (portfolio.positions.length === 0) return "  (empty)";

  return portfolio.positions
    .map((p) => {
      const share = portfolio.totalValueUsd > 0 ? (p.valueUsd / portfolio.totalValueUsd) * 100 : 0;
      const qty = Number(formatUnits(p.amount, p.decimals));
      return `  ${p.symbol}: ${qty.toFixed(6)} — ${usd(p.valueUsd)}, ${share.toFixed(1)}% of the treasury${p.isStable ? " (stablecoin)" : ""}`;
    })
    .join("\n");
}

function describeCandidate(c: Candidate): string {
  const head = `  ${c.symbol} (${c.token})`;

  if (!c.risk) {
    return `${head}\n    no historical data available${c.note ? `\n    note: ${c.note}` : ""}`;
  }

  const wallets =
    c.risk.holderConcentrationExContractsPct === null
      ? "unknown"
      : `${c.risk.holderConcentrationExContractsPct.toFixed(2)}%`;

  return [
    head,
    `    first traded ${c.risk.ageDays.toFixed(0)} days ago`,
    `    lowest liquidity across the last 30 days: ${usd(c.risk.sustainedLiquidityUsd)}`,
    `    held by wallets among the top 10 holders: ${wallets} (${c.risk.contractsInTopHolders} of those 10 are contracts)`,
    c.note ? `    note: ${c.note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildPrompt(input: PlanInput): string {
  const { mandate, portfolio, candidates, signals } = input;

  return [
    "You manage a treasury on Base under a mandate the owner signed.",
    "",
    "Your mandate:",
    describeTerms(mandate),
    "",
    `Treasury, ${usd(portfolio.totalValueUsd)} total:`,
    describePortfolio(portfolio),
    "",
    "Tokens you may consider, with what the historical on-chain record says about each:",
    candidates.map(describeCandidate).join("\n"),
    signals?.length ? `\nSignals that reached you:\n${signals.map((s) => `  - ${s}`).join("\n")}` : "",
    "",
    "Propose at most one action, or none if sitting still is right.",
    "",
    "Say what you would do and why, in two or three sentences. Reference the specific numbers you",
    "relied on. If a clause makes an action a bad idea, say so rather than proposing it — but the",
    "decision to act is yours, and it will be checked independently before anything executes.",
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export async function planAction(input: PlanInput): Promise<PlanResult> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new PlannerError("ANTHROPIC_API_KEY is not set");
  }

  const model = input.model ?? "claude-opus-5";
  const client = new Anthropic();

  let response;
  try {
    response = await client.messages.parse({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: buildPrompt(input) }],
      output_config: { format: zodOutputFormat(planSchema) },
    });
  } catch (error) {
    throw new PlannerError("the model call failed", error);
  }

  if (response.stop_reason === "refusal") {
    throw new PlannerError(`the model declined: ${response.stop_details?.category ?? "unknown"}`);
  }

  const plan = response.parsed_output;
  if (!plan) {
    throw new PlannerError("the model returned no parseable plan");
  }

  if (plan.action === "none") {
    return { plan, proposal: null, model };
  }

  const match = input.candidates.find(
    (c) => c.symbol.toLowerCase() === plan.symbol.toLowerCase()
  );

  if (!match) {
    throw new PlannerError(
      `the model proposed ${plan.symbol}, which is not among the candidates it was given`
    );
  }

  if (!(plan.amountUsd > 0)) {
    throw new PlannerError(`the model proposed a non-positive size: ${plan.amountUsd}`);
  }

  return {
    plan,
    model,
    proposal: {
      kind: plan.action,
      token: match.token,
      symbol: match.symbol,
      amountUsd: plan.amountUsd,
      venue: input.venue,
      rationale: plan.rationale,
    },
  };
}
