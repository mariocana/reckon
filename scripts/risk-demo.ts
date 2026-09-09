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
      console.error(`Poi: echo 'GRAPH_API_KEY=...' >> .env`);
    }
    process.exit(1);
  }
  throw error;
}

const { risk, pools, liquidityByDay, circulatingSupply, concentrationUnavailable, concentrationExcludingContractsPct, contractHolders } = evidence;

console.log(`${risk.symbol}  ${token}`);
console.log(`  prima pool     ${risk.firstSeenAt.slice(0, 10)}  (${risk.ageDays.toFixed(0)} giorni)`);
console.log(`  pool trovate   ${pools.length}, TVL massima $${pools[0].totalValueLockedUSD.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
console.log(`  liquidità min  $${risk.sustainedLiquidityUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })} su ${liquidityByDay.length} giorni`);
if (risk.holderConcentrationPct !== null && circulatingSupply !== null) {
  console.log(`  top 10 holder  ${risk.holderConcentrationPct.toFixed(2)}% di ${circulatingSupply.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
  if (concentrationExcludingContractsPct !== null) {
    console.log(`  di cui non-contratti  ${concentrationExcludingContractsPct.toFixed(2)}%  (${contractHolders}/10 sono contratti)`);
  }
} else {
  console.log(`  top 10 holder  non misurata — ${concentrationUnavailable}`);
}

const action: ProposedAction = {
  kind: "buy",
  token,
  symbol: risk.symbol,
  amountUsd: 400,
  venue: "uniswap",
  rationale: "Test del percorso §4 con dati reali da The Graph.",
};

const verdict = evaluate(mandate, action, {
  portfolio,
  risk,
  stables: [USDC],
  now: new Date(),
  lastTradeAt: new Date(Date.now() - 7200_000),
});

console.log(`\n${action.kind} $${action.amountUsd} ${action.symbol} su ${action.venue}`);
console.log(`  → ${describeVerdict(verdict)}`);

if (verdict.kind !== "allow") {
  for (const v of verdict.violations) {
    console.log(`     ${v.clause} [${v.severity}] ${v.explain}`);
    console.log(`        osservato ${v.observed}, ammesso ${v.limit}`);
  }
}

console.log(`  mandato ${verdict.mandateHash}`);
