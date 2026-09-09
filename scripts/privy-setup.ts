import { readFileSync, writeFileSync } from "node:fs";
import type { Address } from "viem";
import { PrivyClient } from "@privy-io/node";
import { compileMandateToPolicy } from "@/lib/exec/privy";
import { mandateSchema, describeTerms, mandateHash, type Mandate } from "@/lib/mandate/schema";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const cbBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;

const client = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

const existing = await client.wallets().list();
const wallets = (existing as { data?: Array<{ id: string; address: string }> }).data ?? [];

let wallet = wallets[0];

if (wallet) {
  console.log(`wallet esistente  ${wallet.id}  ${wallet.address}`);
} else {
  wallet = (await client.wallets().create({ chain_type: "ethereum" })) as typeof wallet;
  console.log(`wallet creato     ${wallet.id}  ${wallet.address}`);
}

const mandate: Mandate = mandateSchema.parse({
  version: 1,
  owner: "0x1111111111111111111111111111111111111111",
  agent: wallet.address as `0x${string}`,
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

console.log(`\n${describeTerms(mandate)}`);
console.log(`\nmandato ${mandateHash(mandate)}\n`);

const compiled = compileMandateToPolicy(mandate, {
  tokenAllowlist: [USDC, WETH, cbBTC],
  spendToken: USDC,
  spendTokenDecimals: 6,
});

let policyId: string | null = null;
try {
  const policy = await client.policies().create({
    name: compiled.name,
    chain_type: compiled.chain_type,
    version: compiled.version,
    rules: compiled.rules,
  } as never);
  policyId = (policy as { id: string }).id;
  console.log(`policy creata     ${policyId}`);
} catch (error) {
  console.log(`policy RIFIUTATA  ${String((error as Error).message).split("\n")[0].slice(0, 300)}`);
}

if (policyId) {
  try {
    await client.wallets().update(wallet.id, { policy_ids: [policyId] } as never);
    console.log(`policy applicata al wallet`);
  } catch (error) {
    console.log(`attach fallito    ${String((error as Error).message).split("\n")[0].slice(0, 300)}`);
  }
}

const env = readFileSync(".env", "utf8")
  .split("\n")
  .filter((l) => l.trim() && !l.startsWith("PRIVY_WALLET_ID=") && !l.startsWith("PRIVY_WALLET_ADDRESS=") && !l.startsWith("PRIVY_POLICY_ID="));

env.push(`PRIVY_WALLET_ID=${wallet.id}`);
env.push(`PRIVY_WALLET_ADDRESS=${wallet.address}`);
if (policyId) env.push(`PRIVY_POLICY_ID=${policyId}`);

writeFileSync(".env", env.join("\n") + "\n");
console.log(`\n.env aggiornato`);
console.log(`BaseScan https://basescan.org/address/${wallet.address}`);
