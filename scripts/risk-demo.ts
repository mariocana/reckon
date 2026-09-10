import type { Address } from "viem";
import { getTokenRisk } from "@/lib/data/risk";
import { GraphError } from "@/lib/data/graph";
import { describeVerdict, evaluate } from "@/lib/mandate/evaluate";
import { mandateSchema, type Mandate } from "@/lib/mandate/schema";
import type { Portfolio, ProposedAction } from "@/lib/types";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;

const token = (process.argv[2] as Address) ?? WETH;

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
    venues: { allowed: ["uniswap"] },
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

let evidence;
try {
  evidence = await getTokenRisk(token);
} catch (error) {
  if (error instanceof GraphError) {
    console.error(`${error.message}`);
    if (!process.env.GRAPH_API_KEY) {
      console.error(`\nServe una chiave: https://thegraph.com/studio → API Keys`);
      console.error(`Then: echo 'GRAPH_API_KEY=...' >> .env`);
    }
    process.exit(1);
  }
  throw error;
}

const { risk, pools, liquidityByDay, circulatingSupply, concentrationUnavailable, concentrationExcludingContractsPct, contractHolders } = evidence;

console.log(`${risk.symbol}  ${token}`);
console.log(`  first pool     ${risk.firstSeenAt.slice(0, 10)}  (${risk.ageDays.toFixed(0)} days old)`);
console.log(`  pools found    ${pools.length}, deepest TVL $${pools[0].totalValueLockedUSD.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
console.log(`  trough liq.    $${risk.sustainedLiquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} across ${liquidityByDay.length} days`);
if (risk.holderConcentrationPct !== null && circulatingSupply !== null) {
  console.log(`  top 10 holders ${risk.holderConcentrationPct.toFixed(2)}% of ${circulatingSupply.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  if (concentrationExcludingContractsPct !== null) {
    console.log(`  wallets only   ${concentrationExcludingContractsPct.toFixed(2)}%  (${contractHolders} of the top 10 are contracts)`);
  }
} else {
  console.log(`  top 10 holders not measured — ${concentrationUnavailable}`);
}

const action: ProposedAction = {
  kind: "buy",
  token,
  symbol: risk.symbol,
  amountUsd: 400,
  venue: "uniswap",
  rationale: "Testing the §4 path against live Graph data.",
};

const verdict = evaluate(mandate, action, {
  portfolio,
  risk,
  stables: [USDC],
  now: new Date(),
  lastTradeAt: new Date(Date.now() - 7200_000),
});

console.log(`\n${action.kind} $${action.amountUsd} ${action.symbol} on ${action.venue}`);
console.log(`  → ${describeVerdict(verdict)}`);

if (verdict.kind !== "allow") {
  for (const v of verdict.violations) {
    console.log(`     ${v.clause} [${v.severity}] ${v.explain}`);
    console.log(`        observed ${v.observed}, allowed ${v.limit}`);
  }
}

console.log(`  mandate ${verdict.mandateHash}`);
