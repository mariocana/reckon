import { formatUnits, parseAbi, type Address, type PublicClient } from "viem";
import type { Portfolio, Position } from "@/lib/types";
import { UniswapVenue } from "@/lib/exec/uniswap";

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

export interface TrackedToken {
  address: Address;
  isStable: boolean;
}

export async function readPortfolio(
  client: PublicClient,
  owner: Address,
  tokens: TrackedToken[],
  quoteToken: Address
): Promise<Portfolio> {
  const venue = new UniswapVenue(client);
  const positions: Position[] = [];

  for (const token of tokens) {
    const [amount, decimals, symbol] = await Promise.all([
      client.readContract({ address: token.address, abi: erc20, functionName: "balanceOf", args: [owner] }),
      client.readContract({ address: token.address, abi: erc20, functionName: "decimals" }),
      client.readContract({ address: token.address, abi: erc20, functionName: "symbol" }),
    ]);

    if (amount === 0n) continue;

    let valueUsd = 0;

    if (token.isStable) {
      valueUsd = Number(formatUnits(amount, decimals));
    } else {
      try {
        const quote = await venue.quote({
          sellToken: token.address,
          buyToken: quoteToken,
          sellAmount: amount,
          slippageBps: 100,
          taker: owner,
        });
        valueUsd = Number(formatUnits(quote.buyAmount, 6));
      } catch {
        valueUsd = 0;
      }
    }

    positions.push({
      token: token.address,
      symbol,
      decimals,
      amount,
      valueUsd,
      isStable: token.isStable,
    });
  }

  return {
    totalValueUsd: positions.reduce((sum, p) => sum + p.valueUsd, 0),
    positions,
    asOf: new Date().toISOString(),
  };
}

export function formatPortfolio(portfolio: Portfolio): string {
  if (portfolio.positions.length === 0) return "  (vuoto)";

  return portfolio.positions
    .map((p) => {
      const share = portfolio.totalValueUsd > 0 ? (p.valueUsd / portfolio.totalValueUsd) * 100 : 0;
      const qty = Number(formatUnits(p.amount, p.decimals));
      return `  ${p.symbol.padEnd(6)} ${qty.toFixed(6).padStart(14)}  $${p.valueUsd.toFixed(2).padStart(9)}  ${share.toFixed(1)}%`;
    })
    .join("\n");
}
