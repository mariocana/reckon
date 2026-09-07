import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { getBestPoolForPair } from "@/lib/data/graph";
import { VenueError, type Signer, type SwapExecution, type SwapQuote, type SwapRequest, type Venue } from "./venue";

export const UNISWAP_ADDRESSES = {
  swapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  quoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  v3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
} as const satisfies Record<string, Address>;

export const FEE_TIERS = [100, 500, 3000, 10000] as const;

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);

const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export interface UniswapQuoteDetail {
  feeTier: number;
  poolId: string | null;
  poolTvlUsd: number | null;
  gasEstimate: bigint;
  feeTierSource: "subgraph" | "probe";
  subgraphFeeTier: number | null;
  tiersPriced: Array<{ fee: number; amountOut: bigint }>;
  subgraphError?: string;
}

function defaultClient(): PublicClient {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  }) as PublicClient;
}

export class UniswapVenue implements Venue {
  readonly id = "uniswap" as const;

  constructor(private readonly client: PublicClient = defaultClient()) {}

  private async quoteAtFee(request: SwapRequest, fee: number) {
    const { result } = await this.client.simulateContract({
      address: UNISWAP_ADDRESSES.quoterV2,
      abi: QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn: request.sellToken,
          tokenOut: request.buyToken,
          amountIn: request.sellAmount,
          fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return { amountOut: result[0], gasEstimate: result[3] };
  }

  async quote(request: SwapRequest): Promise<SwapQuote> {
    if (request.sellAmount <= 0n) {
      throw new VenueError("uniswap", "sellAmount must be positive");
    }

    let pool = null;
    let subgraphError: string | undefined;
    try {
      pool = await getBestPoolForPair(request.sellToken, request.buyToken);
      if (!pool) subgraphError = "no pool for this pair in the subgraph";
    } catch (error) {
      subgraphError = (error as Error).message;
    }

    const candidates = pool
      ? [pool.feeTier, ...FEE_TIERS.filter((f) => f !== pool.feeTier)]
      : [...FEE_TIERS];

    const settled = await Promise.all(
      candidates.map(async (fee) => {
        try {
          const { amountOut, gasEstimate } = await this.quoteAtFee(request, fee);
          return amountOut > 0n ? { fee, amountOut, gasEstimate } : null;
        } catch {
          return null;
        }
      })
    );

    const priced = settled.filter((r) => r !== null);

    if (priced.length === 0) {
      throw new VenueError(
        "uniswap",
        `no fee tier could price this swap${subgraphError ? ` — ${subgraphError}` : ""}`
      );
    }

    const best = priced.reduce((a, b) => (b.amountOut > a.amountOut ? b : a));
    const matchesSubgraph = pool?.feeTier === best.fee;

    const detail: UniswapQuoteDetail = {
      feeTier: best.fee,
      poolId: matchesSubgraph ? pool!.id : null,
      poolTvlUsd: matchesSubgraph ? pool!.totalValueLockedUSD : null,
      gasEstimate: best.gasEstimate,
      feeTierSource: matchesSubgraph ? "subgraph" : "probe",
      subgraphFeeTier: pool?.feeTier ?? null,
      tiersPriced: priced.map((r) => ({ fee: r.fee, amountOut: r.amountOut })),
      subgraphError,
    };

    return {
      venue: this.id,
      request,
      buyAmount: best.amountOut,
      minBuyAmount: (best.amountOut * BigInt(10_000 - request.slippageBps)) / 10_000n,
      raw: detail,
    };
  }

  async execute(quote: SwapQuote, signer: Signer): Promise<SwapExecution> {
    if (quote.venue !== this.id) {
      throw new VenueError("uniswap", `quote came from ${quote.venue}`);
    }

    const detail = quote.raw as UniswapQuoteDetail;
    const { request } = quote;

    const allowance = await this.client.readContract({
      address: request.sellToken,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [signer.address, UNISWAP_ADDRESSES.swapRouter02],
    });

    if (allowance < request.sellAmount) {
      const approveHash = await signer.sendTransaction({
        to: request.sellToken,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [UNISWAP_ADDRESSES.swapRouter02, request.sellAmount],
        }),
      });
      await this.client.waitForTransactionReceipt({ hash: approveHash });
    }

    const txHash = await signer.sendTransaction({
      to: UNISWAP_ADDRESSES.swapRouter02,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: request.sellToken,
            tokenOut: request.buyToken,
            fee: detail.feeTier,
            recipient: signer.address,
            amountIn: request.sellAmount,
            amountOutMinimum: quote.minBuyAmount,
            sqrtPriceLimitX96: 0n,
          },
        ],
      }),
    });

    const receipt = await this.client.waitForTransactionReceipt({ hash: txHash });

    if (receipt.status !== "success") {
      throw new VenueError("uniswap", `swap reverted in ${txHash}`);
    }

    return {
      venue: this.id,
      txHash,
      filledBuyAmount: quote.buyAmount,
      slippageBps: 0,
    };
  }
}

export function encodeExactInputSingle(params: {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  recipient: Address;
  amountIn: bigint;
  amountOutMinimum: bigint;
}): Hex {
  return encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [{ ...params, sqrtPriceLimitX96: 0n }],
  });
}
