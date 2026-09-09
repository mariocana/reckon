import { createPublicClient, http, size, type Address, type PublicClient } from "viem";
import { base } from "viem/chains";
import {
  AQUA_ADDRESSES,
  SWAP_VM_ABI,
  buildTakerTraitsAndData,
  findShippedOrders,
  makerBalance,
} from "@/lib/exec/aqua";

const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(RPC) }) as PublicClient;

const TOKENS: Record<string, Address> = {
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  WETH: "0x4200000000000000000000000000000000000006",
  cbBTC: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
};

const head = await client.getBlockNumber();
console.log(`Base block ${head} via ${RPC}\n`);

const strategies = await findShippedOrders(client, { limit: 8 });
console.log(`${strategies.length} strategie attive decodificate come Order\n`);

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const s of strategies) {
  const onChainHash = await client
    .readContract({
      address: AQUA_ADDRESSES.swapVmRouter,
      abi: SWAP_VM_ABI,
      functionName: "hash",
      args: [s.order],
    })
    .catch(() => null);
  await pause(250);

  const held: string[] = [];
  for (const [symbol, token] of Object.entries(TOKENS)) {
    const amount = await makerBalance(client, s, token).catch(() => 0n);
    if (amount > 0n) held.push(`${symbol} ${amount}`);
    await pause(250);
  }

  const hashState = onChainHash === null ? "non letto" : onChainHash === s.strategyHash ? "ok" : "NO";

  console.log(
    `${s.strategyHash.slice(0, 12)}…  blocco ${s.blockNumber}  ` +
      `program ${size(s.order.data)} byte  hash ${hashState}`
  );
  console.log(`   maker ${s.order.maker}  ${held.join(", ") || "nessun saldo nei token noti"}`);
}

const target = strategies[0];
if (!target) process.exit(1);

const takerData = buildTakerTraitsAndData({
  taker: target.order.maker,
  isExactIn: true,
  isAToB: true,
  threshold: 0n,
});

console.log(`\nquote() su ${target.strategyHash.slice(0, 12)}… con takerData da ${size(takerData)} byte`);

for (const amount of [1n, 1_000n, 100_000n]) {
  try {
    const [amountIn, amountOut] = await client.readContract({
      address: AQUA_ADDRESSES.swapVmRouter,
      abi: SWAP_VM_ABI,
      functionName: "quote",
      args: [target.order, amount, takerData],
    });
    console.log(`  ${amount}  ->  in ${amountIn}  out ${amountOut}`);
  } catch {
    console.log(`  ${amount}  ->  revert (il RPC pubblico non espone il motivo)`);
  }
}
