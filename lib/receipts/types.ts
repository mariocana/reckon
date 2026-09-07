import type { Address, Hex } from "viem";
import type { Verdict } from "@/lib/mandate/evaluate";
import type { TokenRisk, VenueId } from "@/lib/types";

export interface Observation {
  source: "thegraph";
  queriedAt: string;
  risk: TokenRisk | null;
  poolsSeen: number;
  bestPoolTvlUsd: number | null;
}

export interface Proposal {
  kind: "buy" | "sell";
  token: Address;
  symbol: string;
  amountUsd: number;
  venue: VenueId;
  rationale: string;
}

export interface Authorization {
  layer: "privy-policy" | "human-escalation" | "none";
  outcome: "granted" | "refused" | "pending";
  signer: Address | null;
  detail: string;
}

export interface Execution {
  venue: VenueId;
  txHash: Hex;
  feeTier: number;
  sellAmount: string;
  buyAmount: string;
  minBuyAmount: string;
  status: "success" | "reverted";
}

export interface Outcome {
  markedAt: string;
  costBasisUsd: number;
  markPriceUsd: number | null;
  unrealizedPnlUsd: number | null;
}

export interface Receipt {
  id: string;
  createdAt: string;
  mandateHash: Hex;
  trigger: string;
  observation: Observation;
  proposal: Proposal;
  verdict: Verdict;
  authorization: Authorization;
  execution: Execution | null;
  outcome: Outcome | null;
}

export function summarize(receipt: Receipt): string {
  const { proposal, verdict, authorization, execution } = receipt;
  const head = `${proposal.kind} $${proposal.amountUsd} ${proposal.symbol} on ${proposal.venue}`;

  if (verdict.kind === "deny") {
    const clauses = [...new Set(verdict.violations.map((v) => v.clause))].join(", ");
    return `${head} — refused by the mandate (${clauses})`;
  }

  if (verdict.kind === "escalate") {
    return `${head} — beyond the mandate, ${authorization.outcome === "granted" ? "the owner approved" : "waiting on the owner"}`;
  }

  if (execution) {
    return `${head} — executed, ${execution.txHash.slice(0, 12)}…`;
  }

  return `${head} — allowed but not executed: ${authorization.detail}`;
}
