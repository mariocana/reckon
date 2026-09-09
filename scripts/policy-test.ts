import { PrivyClient } from "@privy-io/node";
import { encodeFunctionData, type Address } from "viem";
import { UNISWAP_ADDRESSES } from "@/lib/exec/uniswap";
import { EXACT_INPUT_SINGLE_ABI } from "@/lib/exec/privy";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const WETH = "0x4200000000000000000000000000000000000006" as Address;
const DEGEN = "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" as Address;

const client = new PrivyClient({ appId: process.env.PRIVY_APP_ID!, appSecret: process.env.PRIVY_APP_SECRET! });
const walletId = process.env.PRIVY_WALLET_ID!;
const me = process.env.PRIVY_WALLET_ADDRESS! as Address;

function swapData(tokenOut: Address, amountIn: bigint) {
  return encodeFunctionData({
    abi: EXACT_INPUT_SINGLE_ABI,
    functionName: "exactInputSingle",
    args: [{ tokenIn: USDC, tokenOut, fee: 500, recipient: me, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
  });
}

const cases: Array<{ label: string; to: Address; data: `0x${string}` }> = [
  { label: "WETH $400  (dentro il mandato)", to: UNISWAP_ADDRESSES.swapRouter02, data: swapData(WETH, 400_000_000n) },
  { label: "DEGEN $400 (§4: fuori allowlist)", to: UNISWAP_ADDRESSES.swapRouter02, data: swapData(DEGEN, 400_000_000n) },
  { label: "WETH $900  (§3: oltre il cap)", to: UNISWAP_ADDRESSES.swapRouter02, data: swapData(WETH, 900_000_000n) },
  { label: "invio a un indirizzo qualsiasi (§6)", to: DEGEN, data: "0x" },
];

for (const c of cases) {
  try {
    await client.wallets().ethereum().signTransaction(walletId, {
      params: { transaction: { to: c.to, data: c.data, value: "0x0", chain_id: 8453, nonce: 0, gas_limit: 300000, max_fee_per_gas: 1000000000, max_priority_fee_per_gas: 1000000 } },
    } as never);
    console.log(`${c.label.padEnd(36)} FIRMATA`);
  } catch (e) {
    const m = String((e as Error).message).split("\n")[0];
    const denied = /polic|denied|not allowed|unauthorized/i.test(m);
    console.log(`${c.label.padEnd(36)} ${denied ? "BLOCCATA DALLA POLICY" : "altro errore"}  ${m.slice(0, 110)}`);
  }
}
