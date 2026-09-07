import { createPublicClient, http, type Address } from "viem";
import { base } from "viem/chains";
import { AQUA_ADDRESSES } from "@/lib/exec/aqua";

const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(RPC) });

const RANGE = 10_000n;
const WINDOWS = 5;

const head = await client.getBlockNumber();
console.log(`Base block ${head} via ${RPC}\n`);

for (const [name, address] of Object.entries(AQUA_ADDRESSES) as Array<[string, Address]>) {
  const code = await client.getCode({ address });
  const bytes = code && code !== "0x" ? (code.length - 2) / 2 : 0;

  if (bytes === 0) {
    console.log(`${name.padEnd(14)} ${address}  NO CODE — wrong address or wrong chain`);
    continue;
  }

  let events = 0;
  let scanned = 0n;
  let to = head;

  for (let i = 0; i < WINDOWS; i++) {
    const from = to - RANGE + 1n;
    try {
      events += (await client.getLogs({ address, fromBlock: from, toBlock: to })).length;
      scanned += RANGE;
    } catch (error) {
      console.log(`  (range ${from}-${to} rejected: ${(error as Error).message.slice(0, 60)})`);
      break;
    }
    to = from - 1n;
  }

  const hours = (Number(scanned) * 2) / 3600; // Base targets 2s blocks
  console.log(
    `${name.padEnd(14)} ${address}  ${bytes.toLocaleString()} bytes` +
      `  ${events} events in ${scanned} blocks (~${hours.toFixed(0)}h)`
  );
}
