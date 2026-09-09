import { readFileSync } from "node:fs";
import {
  createPublicClient,
  encodeFunctionData,
  http,
  slice,
  toFunctionSelector,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import {
  AQUA_ADDRESSES,
  SWAP_VM_ABI,
  buildTakerTraitsAndData,
  findShippedOrders,
  makerBalance,
} from "@/lib/exec/aqua";

const signatures: string[] = JSON.parse(readFileSync("lib/exec/swapvm-errors.json", "utf8"));
const bySelector = new Map<string, string>();
for (const s of signatures) bySelector.set(toFunctionSelector(`function ${s}`), s);

const configured = process.env.BASE_RPC_URL;
const endpoints = [
  ...(configured ? [configured] : []),
  "https://mainnet.base.org",
  "https://base.drpc.org",
  "https://base-rpc.publicnode.com",
];

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;

const LOGS_RPC = process.env.BASE_LOGS_RPC_URL ?? "https://mainnet.base.org";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const logsClient = createPublicClient({ chain: base, transport: http(LOGS_RPC) }) as PublicClient;
const client = createPublicClient({
  chain: base,
  transport: http(configured ?? LOGS_RPC),
}) as PublicClient;

console.log(`${signatures.length} custom error noti`);
console.log(`log da ${new URL(LOGS_RPC).host}, call da ${new URL(configured ?? LOGS_RPC).host}\n`);

const strategies = await findShippedOrders(logsClient, { limit: 8 });
const scored = [];

for (const s of strategies) {
  const usdc = await makerBalance(client, s, USDC).catch(() => 0n);
  await pause(250);
  const weth = await makerBalance(client, s, WETH).catch(() => 0n);
  await pause(250);
  const sides = (usdc > 0n ? 1 : 0) + (weth > 0n ? 1 : 0);
  scored.push({ strategy: s, sides, usdc, weth });
  console.log(`${s.strategyHash.slice(0, 14)}…  USDC ${usdc}  WETH ${weth}`);
}

scored.sort((a, b) => b.sides - a.sides);
const target = scored[0];

if (!target) {
  console.log("nessuna strategia");
  process.exit(1);
}

console.log(`\nsonda su ${target.strategy.strategyHash.slice(0, 14)}… (${target.sides} lati finanziati)\n`);

async function rawCall(url: string, data: Hex) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: AQUA_ADDRESSES.swapVmRouter, data }, "latest"],
    }),
  });
  return res.json() as Promise<{ result?: Hex; error?: { message?: string; data?: string } }>;
}

let resolved = false;

for (const isAToB of [true, false]) {
  const takerData = buildTakerTraitsAndData({
    taker: target.strategy.order.maker,
    isExactIn: true,
    isAToB,
    threshold: 0n,
  });
  const data = encodeFunctionData({
    abi: SWAP_VM_ABI,
    functionName: "quote",
    args: [target.strategy.order, 1000n, takerData],
  });

  for (const url of endpoints) {
    const host = new URL(url).host;
    let json;
    try {
      json = await rawCall(url, data);
    } catch {
      console.log(`AToB=${isAToB}  ${host}  richiesta fallita`);
      continue;
    }

    if (json.result) {
      console.log(`AToB=${isAToB}  ${host}  OK ${json.result.slice(0, 70)}`);
      resolved = true;
      break;
    }

    const revertData = json.error?.data;
    if (typeof revertData === "string" && revertData.startsWith("0x") && revertData.length >= 10) {
      const selector = slice(revertData as Hex, 0, 4);
      console.log(`AToB=${isAToB}  ${host}  ${bySelector.get(selector) ?? `sconosciuto ${selector}`}`);
      console.log(`   ${revertData.slice(0, 138)}`);
      resolved = true;
      break;
    }

    console.log(`AToB=${isAToB}  ${host}  ${json.error?.message ?? "nessun dato"}`);
    await pause(200);
  }
}

if (!resolved) {
  console.log(`\nNessun endpoint ha restituito i dati di revert.`);
  console.log(`Serve un RPC che li esponga — imposta BASE_RPC_URL in .env e rilancia.`);
}
