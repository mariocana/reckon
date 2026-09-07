import type { Address } from "viem";
import { describeTerms, mandateSchema, type Mandate } from "@/lib/mandate/schema";
import { describeVerdict, evaluate, type EvaluationContext } from "@/lib/mandate/evaluate";
import type { Portfolio, ProposedAction, TokenRisk } from "@/lib/types";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const FRESH = "0x000000000000000000000000000000000000dEaD" as Address;

const mandate: Mandate = mandateSchema.parse({
  version: 1,
  owner: "0x1111111111111111111111111111111111111111",
  agent: "0x2222222222222222222222222222222222222222",
  chainId: 8453,
  issuedAt: "2026-09-07T00:00:00.000Z",
  expiresAt: "2026-12-31T00:00:00.000Z",
  clauses: {
    reserve: { minStablePct: 60 },
    concentration: { maxSingleAssetPct: 15 },
    tradeSize: { maxPerTradeUsd: 500 },
    universe: {
      minTokenAgeDays: 90,
      minSustainedLiquidityUsd: 2_000_000,
      maxHolderConcentrationPct: 40,
    },
    cadence: { minSecondsBetweenTrades: 3600 },
    venues: { allowed: ["1inch-aqua"] },
  },
} satisfies Mandate);

const portfolio: Portfolio = {
  totalValueUsd: 10_000,
  asOf: new Date().toISOString(),
  positions: [
    { token: USDC, symbol: "USDC", decimals: 6, amount: 9000n * 10n ** 6n, valueUsd: 9000, isStable: true },
    { token: WETH, symbol: "WETH", decimals: 18, amount: 10n ** 18n / 4n, valueUsd: 1000, isStable: false },
  ],
};

const wethRisk: TokenRisk = {
  token: WETH,
  symbol: "WETH",
  firstSeenAt: "2023-06-01T00:00:00.000Z",
  ageDays: 1194,
  sustainedLiquidityUsd: 48_000_000,
  holderConcentrationPct: 52,
  holderConcentrationExContractsPct: 12,
  contractsInTopHolders: 9,
  source: "thegraph",
  queriedAt: new Date().toISOString(),
};

const freshRisk: TokenRisk = {
  token: FRESH,
  symbol: "PUMP",
  firstSeenAt: "2026-09-01T00:00:00.000Z",
  ageDays: 6,
  sustainedLiquidityUsd: 41_000,
  holderConcentrationPct: 78,
  holderConcentrationExContractsPct: 78,
  contractsInTopHolders: 0,
  source: "thegraph",
  queriedAt: new Date().toISOString(),
};

const baseCtx: Omit<EvaluationContext, "risk"> = {
  portfolio,
  stables: [USDC],
  now: new Date("2026-09-07T12:00:00.000Z"),
  lastTradeAt: new Date("2026-09-07T09:00:00.000Z"),
};

const scenarios: Array<{ label: string; action: ProposedAction; risk?: TokenRisk }> = [
  {
    label: "Routine rebalance, inside every clause",
    action: {
      kind: "buy",
      token: WETH,
      symbol: "WETH",
      amountUsd: 400,
      venue: "1inch-aqua",
      rationale: "WETH sits at 20% of target weight; topping up.",
    },
    risk: wethRisk,
  },
  {
    label: "A six-day-old token with thin liquidity",
    action: {
      kind: "buy",
      token: FRESH,
      symbol: "PUMP",
      amountUsd: 100,
      venue: "1inch-aqua",
      rationale: "Trending on socials.",
    },
    risk: freshRisk,
  },
  {
    label: "A sound asset, but a rebalance far past the bounds",
    action: {
      kind: "buy",
      token: WETH,
      symbol: "WETH",
      amountUsd: 4_000,
      venue: "1inch-aqua",
      rationale: "Rebalancing the full WETH underweight in one go.",
    },
    risk: wethRisk,
  },
];

console.log(describeTerms(mandate));

for (const { label, action, risk } of scenarios) {
  const verdict = evaluate(mandate, action, { ...baseCtx, risk });

  console.log(`\n${"─".repeat(72)}`);
  console.log(`${label}`);
  console.log(`  ${action.kind} $${action.amountUsd} ${action.symbol} on ${action.venue}`);
  console.log(`  → ${describeVerdict(verdict)}`);

  if (verdict.kind !== "allow") {
    for (const v of verdict.violations) {
      console.log(`     ${v.clause} [${v.severity}] ${v.explain}`);
      console.log(`        observed ${v.observed}, allowed ${v.limit}`);
    }
  }
  console.log(`  mandate ${verdict.mandateHash}`);
}
