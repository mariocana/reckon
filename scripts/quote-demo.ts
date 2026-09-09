import { formatUnits, type Address } from "viem";
import { UniswapVenue, type UniswapQuoteDetail } from "@/lib/exec/uniswap";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const TAKER = "0x1111111111111111111111111111111111111111" as Address;

const venue = new UniswapVenue();

for (const usd of [100, 400, 5000]) {
  const sellAmount = BigInt(usd) * 10n ** 6n;
  try {
    const q = await venue.quote({
      sellToken: USDC,
      buyToken: WETH,
      sellAmount,
      slippageBps: 50,
      taker: TAKER,
    });
    const d = q.raw as UniswapQuoteDetail;
    const out = Number(formatUnits(q.buyAmount, 18));
    console.log(
      `$${usd} USDC -> ${out.toFixed(6)} WETH  ($${(usd / out).toFixed(2)}/WETH)  ` +
        `fee ${d.feeTier / 10000}%  da ${d.feeTierSource}` +
        (d.poolTvlUsd ? `  TVL $${d.poolTvlUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : "")
    );
    const tiers = d.tiersPriced
      .sort((a, b) => (b.amountOut > a.amountOut ? 1 : -1))
      .map((t) => `${t.fee / 10000}%=${Number(formatUnits(t.amountOut, 18)).toFixed(6)}`)
      .join("  ");
    console.log(`   tier quotate: ${tiers}`);
    console.log(`   subgraph suggeriva ${d.subgraphFeeTier !== null ? d.subgraphFeeTier / 10000 + "%" : "niente"}, vinta ${d.feeTier / 10000}%`);
    if (d.subgraphError) console.log(`   subgraph: ${d.subgraphError.slice(0, 120)}`);
    console.log(`   minimo accettato ${Number(formatUnits(q.minBuyAmount, 18)).toFixed(6)} WETH (slippage 0.5%)`);
  } catch (e) {
    console.log(`$${usd} -> ${(e as Error).message.slice(0, 160)}`);
  }
}
