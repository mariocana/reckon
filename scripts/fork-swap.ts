import { PrivyClient } from "@privy-io/node";
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { UNISWAP_ADDRESSES, UniswapVenue, type UniswapQuoteDetail } from "@/lib/exec/uniswap";
import { EXACT_INPUT_SINGLE_ABI } from "@/lib/exec/privy";

const FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" as Address;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const client = createPublicClient({ chain: base, transport: http(FORK) }) as PublicClient;
const privy = new PrivyClient({
  appId: process.env.PRIVY_APP_ID!,
  appSecret: process.env.PRIVY_APP_SECRET!,
});

const walletId = process.env.PRIVY_WALLET_ID!;
const me = process.env.PRIVY_WALLET_ADDRESS! as Address;

async function signViaPrivy(to: Address, data: Hex): Promise<Hex> {
  const nonce = await client.getTransactionCount({ address: me });
  const fees = await client.estimateFeesPerGas();

  const result = (await privy.wallets().ethereum().signTransaction(walletId, {
    params: {
      transaction: {
        to,
        data,
        value: "0x0",
        chain_id: 8453,
        nonce,
        gas_limit: "0x7a120",
        max_fee_per_gas: `0x${(fees.maxFeePerGas ?? 1_000_000_000n).toString(16)}`,
        max_priority_fee_per_gas: `0x${(fees.maxPriorityFeePerGas ?? 1_000_000n).toString(16)}`,
        type: 2,
      },
    },
  } as never)) as { signed_transaction: string };

  return result.signed_transaction as Hex;
}

async function attempt(label: string, to: Address, data: Hex): Promise<Hex | null> {
  try {
    const raw = await signViaPrivy(to, data);
    const hash = await client.sendRawTransaction({ serializedTransaction: raw });
    const receipt = await client.waitForTransactionReceipt({ hash });
    console.log(`${label.padEnd(38)} ${receipt.status === "success" ? "ESEGUITA" : "revert"}  ${hash.slice(0, 18)}…`);
    return hash;
  } catch (error) {
    const message = String((error as Error).message).split("\n")[0];
    const denied = /policy_violation|policy/i.test(message);
    console.log(`${label.padEnd(38)} ${denied ? "NEGATA DALLA POLICY" : "errore"}  ${message.slice(0, 90)}`);
    return null;
  }
}

const before = await client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [me] });
console.log(`saldo iniziale  ${formatUnits(before, 6)} USDC\n`);

const venue = new UniswapVenue(client);
const sellAmount = 10_000_000n;
const quote = await venue.quote({ sellToken: USDC, buyToken: WETH, sellAmount, slippageBps: 100, taker: me });
const detail = quote.raw as UniswapQuoteDetail;

console.log(`quote  $10 USDC -> ${formatUnits(quote.buyAmount, 18)} WETH  fee ${detail.feeTier / 10000}%\n`);

await attempt(
  "approve router (nel mandato)",
  USDC,
  encodeFunctionData({ abi: erc20, functionName: "approve", args: [UNISWAP_ADDRESSES.swapRouter02, sellAmount] })
);

const swapCall = (tokenOut: Address, amountIn: bigint) =>
  encodeFunctionData({
    abi: EXACT_INPUT_SINGLE_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: USDC,
        tokenOut,
        fee: detail.feeTier,
        recipient: me,
        amountIn,
        amountOutMinimum: tokenOut === WETH ? quote.minBuyAmount : 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

await attempt("swap WETH $10 (nel mandato)", UNISWAP_ADDRESSES.swapRouter02, swapCall(WETH, sellAmount));
await attempt("swap DEGEN $10 (§4 fuori lista)", UNISWAP_ADDRESSES.swapRouter02, swapCall(DEGEN, sellAmount));
await attempt("swap WETH $900 (§3 oltre il cap)", UNISWAP_ADDRESSES.swapRouter02, swapCall(WETH, 900_000_000n));
await attempt("invio a indirizzo qualsiasi (§6)", DEGEN, "0x");

const after = await client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [me] });
const weth = await client.readContract({ address: WETH, abi: erc20, functionName: "balanceOf", args: [me] });

console.log(`\nsaldo finale    ${formatUnits(after, 6)} USDC  +  ${formatUnits(weth, 18)} WETH`);
