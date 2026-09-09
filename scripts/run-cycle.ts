import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { runCycle } from "@/lib/agent/run";
import { formatPortfolio, readPortfolio } from "@/lib/data/portfolio";
import { PrivySigner } from "@/lib/exec/privy";
import { mandateSchema, describeTerms, mandateHash, type Mandate } from "@/lib/mandate/schema";
import { overrideSchema, overrideTypedData, describeOverride, type SignedOverride } from "@/lib/mandate/override";
import { summarize } from "@/lib/receipts/types";
import type { ProposedAction } from "@/lib/types";

const FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const cbBTC = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf" as Address;
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" as Address;

const client = createPublicClient({ chain: base, transport: http(FORK) }) as PublicClient;
const privy = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

const me = process.env.PRIVY_WALLET_ADDRESS! as Address;
const signer = new PrivySigner(me, privy, process.env.PRIVY_WALLET_ID!, 8453, client);

const owner = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");

const mandate: Mandate = mandateSchema.parse({
  version: 1,
  owner: owner.address,
  agent: me,
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

const tracked = [
  { address: USDC, isStable: true },
  { address: WETH, isStable: false },
  { address: cbBTC, isStable: false },
];

console.log(describeTerms(mandate));
console.log(`\nportafoglio`);
console.log(formatPortfolio(await readPortfolio(client, me, tracked, USDC)));

const policyAdmin = {
  walletId: process.env.PRIVY_WALLET_ID!,
  basePolicyId: process.env.PRIVY_POLICY_ID!,
  compileOptions: { tokenAllowlist: [USDC, WETH, cbBTC], spendToken: USDC, spendTokenDecimals: 6 },
  async createPolicy(input: { name: string; chain_type: "ethereum"; version: "1.0"; rules: unknown[] }) {
    const p = await privy.policies().create(input as never);
    return (p as { id: string }).id;
  },
  async attachPolicy(walletId: string, policyIds: string[]) {
    await privy.wallets().update(walletId, { policy_ids: policyIds } as never);
  },
};

const proposals: Array<{ trigger: string; action: ProposedAction }> = [
  {
    trigger: "weekly rebalance: WETH is underweight",
    action: { kind: "buy", token: WETH, symbol: "WETH", amountUsd: 5, venue: "uniswap", rationale: "WETH sits below its target weight." },
  },
  {
    trigger: "flagged by the community",
    action: { kind: "buy", token: DEGEN, symbol: "DEGEN", amountUsd: 5, venue: "uniswap", rationale: "Trending on socials." },
  },
  {
    trigger: "realignment past the concentration ceiling",
    action: { kind: "buy", token: WETH, symbol: "WETH", amountUsd: 12, venue: "uniswap", rationale: "Close the whole WETH gap in one move." },
  },
];

for (const { trigger, action } of proposals) {
  console.log(`\n${"─".repeat(74)}`);
  console.log(`${trigger}`);

  const receipt = await runCycle({
    client,
    signer,
    mandate,
    proposal: action,
    trigger,
    stables: [USDC],
    tracked,
    spendToken: USDC,
  });

  console.log(`  ${summarize(receipt)}`);

  if (receipt.observation.risk) {
    const r = receipt.observation.risk;
    console.log(`  visto      ${r.ageDays.toFixed(0)}g, liquidità min $${(r.sustainedLiquidityUsd / 1e6).toFixed(1)}M, wallet ${r.holderConcentrationExContractsPct?.toFixed(2) ?? "?"}%  (${receipt.observation.poolsSeen} pool)`);
  }

  if (receipt.verdict.kind !== "allow") {
    for (const v of receipt.verdict.violations) {
      console.log(`  ${v.clause} [${v.severity}] ${v.explain}`);
    }
  }

  console.log(`  autorizza  ${receipt.authorization.layer} → ${receipt.authorization.outcome}: ${receipt.authorization.detail}`);
  if (receipt.execution) console.log(`  eseguito   ${receipt.execution.txHash}`);
  console.log(`  ricevuta   ${receipt.id}  mandato ${receipt.mandateHash.slice(0, 14)}…`);
}

const escalated = proposals[2].action;
const override = overrideSchema.parse({
  mandateHash: mandateHash(mandate),
  owner: owner.address,
  agent: me,
  token: escalated.token,
  kind: escalated.kind,
  maxAmountUsd: 15,
  venue: escalated.venue,
  clauses: ["§2.concentration"],
  issuedAt: new Date(Date.now() - 60_000).toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  nonce: `demo-${Date.now()}`,
});

const signed: SignedOverride = {
  override,
  signature: await owner.signTypedData(overrideTypedData(override, mandate.chainId)),
};

console.log(`\n${"─".repeat(74)}`);
console.log(`l'owner autorizza a mano`);
console.log(describeOverride(override).split("\n").map((l) => `  ${l}`).join("\n"));

const authorised = await runCycle({
  client, signer, mandate, proposal: escalated,
  trigger: "realignment, with the owner's signature",
  stables: [USDC], tracked, spendToken: USDC,
  override: signed, policyAdmin,
});

console.log(`\n  ${summarize(authorised)}`);
console.log(`  autorizza  ${authorised.authorization.layer} → ${authorised.authorization.outcome}: ${authorised.authorization.detail}`);
if (authorised.execution) console.log(`  eseguito   ${authorised.execution.txHash}`);
console.log(`  ricevuta   ${authorised.id}`);

console.log(`\nportafoglio finale`);
console.log(formatPortfolio(await readPortfolio(client, me, tracked, USDC)));
