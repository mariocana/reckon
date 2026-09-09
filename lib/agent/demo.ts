import { PrivyClient } from "@privy-io/node";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { runCycle, type PolicyAdmin } from "@/lib/agent/run";
import { PrivySigner } from "@/lib/exec/privy";
import { mandateSchema, mandateHash, type Mandate } from "@/lib/mandate/schema";
import { overrideSchema, overrideTypedData, type SignedOverride } from "@/lib/mandate/override";
import type { Receipt } from "@/lib/receipts/types";
import type { ProposedAction } from "@/lib/types";

export const TOKENS = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
  DEGEN: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed",
} as const satisfies Record<string, Address>;

export type ScenarioId = "rebalance" | "memecoin" | "oversized" | "authorised";

export const SCENARIOS: Record<ScenarioId, { trigger: string; action: ProposedAction }> = {
  rebalance: {
    trigger: "weekly rebalance: WETH is underweight",
    action: {
      kind: "buy",
      token: TOKENS.WETH,
      symbol: "WETH",
      amountUsd: 5,
      venue: "uniswap",
      rationale: "WETH sits below its target weight.",
    },
  },
  memecoin: {
    trigger: "flagged by the community",
    action: {
      kind: "buy",
      token: TOKENS.DEGEN,
      symbol: "DEGEN",
      amountUsd: 5,
      venue: "uniswap",
      rationale: "Trending on socials.",
    },
  },
  oversized: {
    trigger: "realignment past the concentration ceiling",
    action: {
      kind: "buy",
      token: TOKENS.WETH,
      symbol: "WETH",
      amountUsd: 12,
      venue: "uniswap",
      rationale: "Close the whole WETH gap in one move.",
    },
  },
  authorised: {
    trigger: "realignment, with the owner's signature",
    action: {
      kind: "buy",
      token: TOKENS.WETH,
      symbol: "WETH",
      amountUsd: 12,
      venue: "uniswap",
      rationale: "Close the whole WETH gap in one move.",
    },
  },
};

const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

export function demoOwner() {
  return privateKeyToAccount(OWNER_KEY);
}

export function demoMandate(agent: Address): Mandate {
  return mandateSchema.parse({
    version: 1,
    owner: demoOwner().address,
    agent,
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
}

export const TRACKED = [
  { address: TOKENS.USDC, isStable: true },
  { address: TOKENS.WETH, isStable: false },
  { address: TOKENS.cbBTC, isStable: false },
];

export function forkClient(): PublicClient {
  return createPublicClient({
    chain: base,
    transport: http(process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545"),
  }) as PublicClient;
}

export async function runScenario(id: ScenarioId): Promise<Receipt> {
  const client = forkClient();
  const privy = new PrivyClient({
    appId: process.env.PRIVY_APP_ID!,
    appSecret: process.env.PRIVY_APP_SECRET!,
  });

  const agent = process.env.PRIVY_WALLET_ADDRESS! as Address;
  const walletId = process.env.PRIVY_WALLET_ID!;
  const signer = new PrivySigner(agent, privy, walletId, 8453, client);
  const mandate = demoMandate(agent);
  const { trigger, action } = SCENARIOS[id];

  let override: SignedOverride | undefined;
  let policyAdmin: PolicyAdmin | undefined;

  if (id === "authorised") {
    const owner = demoOwner();
    const doc = overrideSchema.parse({
      mandateHash: mandateHash(mandate),
      owner: owner.address,
      agent,
      token: action.token,
      kind: action.kind,
      maxAmountUsd: 15,
      venue: action.venue,
      clauses: ["§2.concentration"],
      issuedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      nonce: `demo-${Date.now()}`,
    });

    override = {
      override: doc,
      signature: await owner.signTypedData(overrideTypedData(doc, mandate.chainId)),
    };

    policyAdmin = {
      walletId,
      basePolicyId: process.env.PRIVY_POLICY_ID!,
      compileOptions: {
        tokenAllowlist: [TOKENS.USDC, TOKENS.WETH, TOKENS.cbBTC],
        spendToken: TOKENS.USDC,
        spendTokenDecimals: 6,
      },
      async createPolicy(input) {
        const p = await privy.policies().create(input as never);
        return (p as { id: string }).id;
      },
      async attachPolicy(id, policyIds) {
        await privy.wallets().update(id, { policy_ids: policyIds } as never);
      },
    };
  }

  return runCycle({
    client,
    signer,
    mandate,
    proposal: action,
    trigger,
    stables: [TOKENS.USDC],
    tracked: TRACKED,
    spendToken: TOKENS.USDC,
    override,
    policyAdmin,
  });
}
