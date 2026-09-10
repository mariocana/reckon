import type { Address } from "viem";
import { compileMandateToPolicy } from "@/lib/exec/privy";
import { mandateSchema, describeTerms, mandateHash, type Mandate } from "@/lib/mandate/schema";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const cbBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;

const mandate: Mandate = mandateSchema.parse({
  version: 1,
  owner: "0x1111111111111111111111111111111111111111",
  agent: (process.env.PRIVY_WALLET_ADDRESS ?? "0x2222222222222222222222222222222222222222") as Address,
  chainId: 8453,
  issuedAt: "2026-09-07T00:00:00.000Z",
  expiresAt: "2026-12-31T00:00:00.000Z",
  clauses: {
    reserve: { minStablePct: 60 },
    concentration: { maxSingleAssetPct: 15 },
    tradeSize: { maxPerTradeUsd: 500 },
    universe: { minTokenAgeDays: 90, minSustainedLiquidityUsd: 2_000_000, maxHolderConcentrationPct: 40 },
    cadence: { minSecondsBetweenTrades: 3600 },
    venues: { allowed: ["uniswap"] },
  },
} satisfies Mandate);

console.log(describeTerms(mandate));
console.log(`\nmandato ${mandateHash(mandate)}\n`);

const policy = compileMandateToPolicy(mandate, {
  tokenAllowlist: [USDC, WETH, cbBTC],
  spendToken: USDC,
  spendTokenDecimals: 6,
});

console.log(JSON.stringify({ name: policy.name, chain_type: policy.chain_type, version: policy.version, rules: policy.rules }, null, 2));
console.log(`\ncosa non entra nella policy:`);
for (const n of policy.notes) console.log(`  - ${n}`);
