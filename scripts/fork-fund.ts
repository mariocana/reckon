import { createPublicClient, createWalletClient, formatUnits, http, parseAbi, type Address } from "viem";
import { base } from "viem/chains";
import { getTopHolders } from "@/lib/data/graph";

const FORK = process.env.FORK_RPC_URL ?? "http://127.0.0.1:8545";
const ADMIN = process.env.FORK_ADMIN_RPC_URL ?? FORK;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
const RESET_TO_ZERO: Address[] = [
  "0x4200000000000000000000000000000000000006",
  "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
];

const target = (process.argv[2] as Address) ?? (process.env.PRIVY_WALLET_ADDRESS as Address);
const wantUsdc = BigInt(process.argv[3] ?? "50") * 10n ** 6n;

const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

const client = createPublicClient({ chain: base, transport: http(FORK) });

async function rpc(url: string, method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
}

const isTenderly = ADMIN.includes("tenderly.co");
const hex = (v: bigint) => `0x${v.toString(16)}`;

console.log(`fork    ${isTenderly ? "Tenderly Virtual TestNet" : "anvil"} @ block ${await client.getBlockNumber()}`);
console.log(`chain   ${await client.getChainId()}`);
console.log(`target  ${target}\n`);

if (isTenderly) {
  await rpc(ADMIN, "tenderly_setBalance", [[target], hex(10n ** 18n)]);
  await rpc(ADMIN, "tenderly_setErc20Balance", [USDC, [target], hex(wantUsdc)]);
  for (const token of RESET_TO_ZERO) {
    await rpc(ADMIN, "tenderly_setErc20Balance", [token, [target], "0x0"]);
  }
  console.log("ETH     1.0 for gas");
  console.log("USDC    written straight to storage");
  console.log(`cleared ${RESET_TO_ZERO.length} non-stable tokens, the portfolio starts clean`);
} else {
  await rpc(ADMIN, "anvil_setBalance", [target, hex(10n ** 18n)]);
  console.log("ETH     1.0 for gas");

  const KNOWN_DONORS: Address[] = ["0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb"];

  let candidates: Address[] = KNOWN_DONORS;
  let donor: Address | undefined;

  for (const a of KNOWN_DONORS) {
    const balance = await client.readContract({
      address: USDC,
      abi: erc20,
      functionName: "balanceOf",
      args: [a],
    });
    if (balance >= wantUsdc) {
      donor = a;
      console.log(`donor    ${a} holds ${formatUnits(balance, 6)} USDC`);
      break;
    }
  }

  if (!donor) {
    try {
      candidates = (await getTopHolders(USDC, 10)).map((h) => h.address);
    } catch {
      console.log("the Token API is down and no known donor has enough USDC");
      process.exit(1);
    }
  }

  for (const h of donor ? [] : candidates.map((address) => ({ address }))) {
    const balance = await client.readContract({
      address: USDC,
      abi: erc20,
      functionName: "balanceOf",
      args: [h.address],
    });
    if (balance >= wantUsdc) {
      donor = h.address;
      console.log(`donor    ${h.address} holds ${formatUnits(balance, 6)} USDC`);
      break;
    }
  }

  if (!donor) {
    console.log("no holder on the fork has enough USDC");
    process.exit(1);
  }

  await rpc(ADMIN, "anvil_impersonateAccount", [donor]);
  await rpc(ADMIN, "anvil_setBalance", [donor, hex(10n ** 18n)]);

  const wallet = createWalletClient({ chain: base, transport: http(FORK), account: donor });
  const hash = await wallet.writeContract({
    address: USDC,
    abi: erc20,
    functionName: "transfer",
    args: [target, wantUsdc],
  });

  await client.waitForTransactionReceipt({ hash });
  await rpc(ADMIN, "anvil_stopImpersonatingAccount", [donor]);

  await rpc(ADMIN, "anvil_impersonateAccount", [target]);
  const agent = createWalletClient({ chain: base, transport: http(FORK), account: target });
  let cleared = 0;

  for (const token of RESET_TO_ZERO) {
    const held = await client.readContract({
      address: token,
      abi: erc20,
      functionName: "balanceOf",
      args: [target],
    });
    if (held === 0n) continue;

    const away = await agent.writeContract({
      address: token,
      abi: erc20,
      functionName: "transfer",
      args: ["0x000000000000000000000000000000000000dEaD", held],
    });
    await client.waitForTransactionReceipt({ hash: away });
    cleared++;
  }

  await rpc(ADMIN, "anvil_stopImpersonatingAccount", [target]);
  console.log(`cleared ${cleared} non-stable tokens, the portfolio starts clean`);
}

const final = await client.readContract({
  address: USDC,
  abi: erc20,
  functionName: "balanceOf",
  args: [target],
});

console.log(`USDC    ${formatUnits(final, 6)} on the wallet`);
