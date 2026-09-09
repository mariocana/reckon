import { hashTypedData, keccak256, toHex, type Address, type Hex } from "viem";
import { z } from "zod";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "not an address") as z.ZodType<Address>;
const isoDate = z.string().datetime({ offset: true });
const pct = z.number().min(0).max(100);

export const clausesSchema = z.object({
  reserve: z.object({
    minStablePct: pct,
  }),
  concentration: z.object({
    maxSingleAssetPct: pct,
  }),
  tradeSize: z.object({
    maxPerTradeUsd: z.number().positive(),
  }),
  universe: z.object({
    minTokenAgeDays: z.number().min(0),
    minSustainedLiquidityUsd: z.number().min(0),
    maxHolderConcentrationPct: pct,
  }),
  cadence: z.object({
    minSecondsBetweenTrades: z.number().min(0),
  }),
  venues: z.object({
    allowed: z.array(z.enum(["1inch-aqua", "uniswap", "0x"])).min(1),
  }),
});

export const mandateSchema = z.object({
  version: z.number().int().positive(),
  owner: address,
  agent: address,
  chainId: z.literal(8453),
  issuedAt: isoDate,
  expiresAt: isoDate,
  clauses: clausesSchema,
});

export type Clauses = z.infer<typeof clausesSchema>;
export type Mandate = z.infer<typeof mandateSchema>;

export type ClauseId =
  | "§0.validity"
  | "§1.reserve"
  | "§2.concentration"
  | "§3.tradeSize"
  | "§4.universe"
  | "§5.cadence"
  | "§6.venue";

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);

  return `{${entries.join(",")}}`;
}

export function hashClauses(clauses: Clauses): Hex {
  return keccak256(toHex(canonicalize(clauses)));
}

export function describeTerms(m: Mandate): string {
  const c = m.clauses;
  const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
  return [
    `Agent ${m.agent} may trade on chain ${m.chainId} until ${m.expiresAt}.`,
    `§1 Keep at least ${c.reserve.minStablePct}% of the treasury in stablecoins.`,
    `§2 Hold no more than ${c.concentration.maxSingleAssetPct}% in any single asset.`,
    `§3 Trade no more than ${usd(c.tradeSize.maxPerTradeUsd)} at a time.`,
    `§4 Only tokens at least ${c.universe.minTokenAgeDays} days old, with at least ${usd(c.universe.minSustainedLiquidityUsd)} of sustained liquidity, and no more than ${c.universe.maxHolderConcentrationPct}% held by the wallets among the top 10 holders, contracts excluded.`,
    `§5 Leave at least ${c.cadence.minSecondsBetweenTrades}s between trades.`,
    `§6 Execute only on: ${c.venues.allowed.join(", ")}.`,
  ].join("\n");
}

export const MANDATE_EIP712_DOMAIN = {
  name: "Reckon Mandate",
  version: "1",
} as const;

export const MANDATE_EIP712_TYPES = {
  Mandate: [
    { name: "version", type: "uint256" },
    { name: "owner", type: "address" },
    { name: "agent", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "terms", type: "string" },
    { name: "clausesHash", type: "bytes32" },
  ],
} as const;

function unixSeconds(iso: string): bigint {
  return BigInt(Math.floor(new Date(iso).getTime() / 1000));
}

export function toTypedData(m: Mandate) {
  return {
    domain: { ...MANDATE_EIP712_DOMAIN, chainId: m.chainId },
    types: MANDATE_EIP712_TYPES,
    primaryType: "Mandate" as const,
    message: {
      version: BigInt(m.version),
      owner: m.owner,
      agent: m.agent,
      chainId: BigInt(m.chainId),
      issuedAt: unixSeconds(m.issuedAt),
      expiresAt: unixSeconds(m.expiresAt),
      terms: describeTerms(m),
      clausesHash: hashClauses(m.clauses),
    },
  };
}

export function mandateHash(m: Mandate): Hex {
  return hashTypedData(toTypedData(m));
}

export interface SignedMandate {
  mandate: Mandate;
  signature: Hex;
  hash: Hex;
}
