import type { Address } from "viem";

export interface Position {
  token: Address;
  symbol: string;
  decimals: number;
  amount: bigint;
  valueUsd: number;
  isStable: boolean;
}

export interface Portfolio {
  totalValueUsd: number;
  positions: Position[];
  asOf: string;
}

export interface TokenRisk {
  token: Address;
  symbol: string;
  firstSeenAt: string;
  ageDays: number;
  sustainedLiquidityUsd: number;
  holderConcentrationPct: number | null;
  holderConcentrationExContractsPct: number | null;
  contractsInTopHolders: number;
  source: "thegraph";
  queriedAt: string;
}

export type VenueId = "1inch-aqua" | "uniswap" | "0x";

export interface ProposedAction {
  kind: "buy" | "sell";
  token: Address;
  symbol: string;
  amountUsd: number;
  venue: VenueId;
  rationale: string;
}
