import type { Address, Hex } from "viem";
import type { VenueId } from "@/lib/types";

export interface SwapRequest {
  sellToken: Address;
  buyToken: Address;
  sellAmount: bigint;
  slippageBps: number;
  taker: Address;
}

export interface SwapQuote {
  venue: VenueId;
  request: SwapRequest;
  buyAmount: bigint;
  minBuyAmount: bigint;
  raw: unknown;
}

export interface SwapExecution {
  venue: VenueId;
  txHash: Hex;
  filledBuyAmount: bigint;
  slippageBps: number;
}

export interface Signer {
  address: Address;
  sendTransaction(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex>;
}

export interface Venue {
  id: VenueId;
  quote(request: SwapRequest): Promise<SwapQuote>;
  execute(quote: SwapQuote, signer: Signer): Promise<SwapExecution>;
}

export class VenueError extends Error {
  constructor(
    readonly venue: VenueId,
    message: string,
    readonly cause?: unknown
  ) {
    super(`[${venue}] ${message}`);
    this.name = "VenueError";
  }
}
