import type { Address, Hex } from "viem";
import type { Mandate } from "@/lib/mandate/schema";
import { UNISWAP_ADDRESSES } from "./uniswap";
import { VenueError, type Signer } from "./venue";

export const EXACT_INPUT_SINGLE_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const VENUE_ROUTERS: Record<string, Address> = {
  uniswap: UNISWAP_ADDRESSES.swapRouter02,
};

export interface CompileOptions {
  tokenAllowlist: Address[];
  spendToken: Address;
  spendTokenDecimals: number;
}

export interface CompiledPolicy {
  name: string;
  chain_type: "ethereum";
  version: "1.0";
  rules: unknown[];
  notes: string[];
}

function maxSpendUnits(mandate: Mandate, decimals: number): bigint {
  const cap = mandate.clauses.tradeSize.maxPerTradeUsd;
  return BigInt(Math.floor(cap * 10 ** decimals));
}

export function compileMandateToPolicy(
  mandate: Mandate,
  options: CompileOptions
): CompiledPolicy {
  const routers = mandate.clauses.venues.allowed
    .map((v) => VENUE_ROUTERS[v])
    .filter((r): r is Address => Boolean(r));

  if (routers.length === 0) {
    throw new VenueError(
      "uniswap",
      `no router is known for the mandate's venues: ${mandate.clauses.venues.allowed.join(", ")}`
    );
  }

  const chainId = String(mandate.chainId);
  const spendCap = maxSpendUnits(mandate, options.spendTokenDecimals);

  const signingMethods = ["eth_sendTransaction", "eth_signTransaction"] as const;

  const rules: unknown[] = signingMethods.flatMap((method) => [
    {
      name: `swap in mandate (${method})`,
      method,
      action: "ALLOW",
      conditions: [
        { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: chainId },
        { field_source: "ethereum_transaction", field: "to", operator: "in", value: routers },
        {
          field_source: "ethereum_calldata",
          abi: EXACT_INPUT_SINGLE_ABI,
          field: "exactInputSingle.params.tokenOut",
          operator: "in",
          value: options.tokenAllowlist,
        },
        {
          field_source: "ethereum_calldata",
          abi: EXACT_INPUT_SINGLE_ABI,
          field: "exactInputSingle.params.amountIn",
          operator: "lte",
          value: spendCap.toString(),
        },
      ],
    },
    {
      name: `approve router (${method})`,
      method,
      action: "ALLOW",
      conditions: [
        { field_source: "ethereum_transaction", field: "chain_id", operator: "eq", value: chainId },
        { field_source: "ethereum_transaction", field: "to", operator: "in", value: options.tokenAllowlist },
        {
          field_source: "ethereum_calldata",
          abi: ERC20_APPROVE_ABI,
          field: "approve.spender",
          operator: "in",
          value: routers,
        },
      ],
    },
  ]);

  return {
    name: `reckon mandate v${mandate.version}`,
    chain_type: "ethereum",
    version: "1.0",
    rules,
    notes: [
      `§3 becomes a cap of ${spendCap} units of ${options.spendToken}; the mandate is denominated in USD, so this holds while the spend token is a dollar stablecoin.`,
      `§4 becomes an allowlist of ${options.tokenAllowlist.length} tokens, resolved off-chain from The Graph before the policy is written.`,
      `§6 becomes the router allowlist: ${routers.join(", ")}.`,
      `Privy denies by default: anything no rule allows is refused. A catch-all DENY rule must NOT be added — a matching DENY overrides every ALLOW.`,
      `Both eth_sendTransaction and eth_signTransaction are constrained; allowing only the former would let the agent sign here and broadcast elsewhere.`,
      `§1, §2 and §5 are portfolio-wide and cannot be expressed per-transaction; they stay with the evaluator.`,
    ],
  };
}

export interface PrivyConfig {
  appId: string;
  appSecret: string;
  walletId: string;
  address: Address;
}

export function privyConfigFromEnv(): PrivyConfig {
  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  const walletId = process.env.PRIVY_WALLET_ID;
  const address = process.env.PRIVY_WALLET_ADDRESS as Address | undefined;

  const missing = [
    !appId && "PRIVY_APP_ID",
    !appSecret && "PRIVY_APP_SECRET",
    !walletId && "PRIVY_WALLET_ID",
    !address && "PRIVY_WALLET_ADDRESS",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new VenueError("uniswap", `missing Privy configuration: ${missing.join(", ")}`);
  }

  return { appId: appId!, appSecret: appSecret!, walletId: walletId!, address: address! };
}

export interface PrivyWalletClient {
  wallets(): {
    ethereum(): {
      signTransaction(walletId: string, input: unknown): Promise<{ signed_transaction: string }>;
    };
  };
}

export interface BroadcastClient {
  getTransactionCount(args: { address: Address }): Promise<number>;
  estimateFeesPerGas(): Promise<{ maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }>;
  sendRawTransaction(args: { serializedTransaction: Hex }): Promise<Hex>;
}

export class PrivySigner implements Signer {
  constructor(
    readonly address: Address,
    private readonly privy: PrivyWalletClient,
    private readonly walletId: string,
    private readonly chainId: number,
    private readonly broadcaster: BroadcastClient,
    private readonly gasLimit = 500_000n
  ) {}

  async sendTransaction(tx: { to: Address; data: Hex; value?: bigint }): Promise<Hex> {
    const nonce = await this.broadcaster.getTransactionCount({ address: this.address });
    const fees = await this.broadcaster.estimateFeesPerGas();
    const hex = (v: bigint) => `0x${v.toString(16)}`;

    const signed = await this.privy.wallets().ethereum().signTransaction(this.walletId, {
      params: {
        transaction: {
          to: tx.to,
          data: tx.data,
          value: hex(tx.value ?? 0n),
          chain_id: this.chainId,
          nonce,
          gas_limit: hex(this.gasLimit),
          max_fee_per_gas: hex(fees.maxFeePerGas ?? 1_000_000_000n),
          max_priority_fee_per_gas: hex(fees.maxPriorityFeePerGas ?? 1_000_000n),
          type: 2,
        },
      },
    });

    return this.broadcaster.sendRawTransaction({
      serializedTransaction: signed.signed_transaction as Hex,
    });
  }
}
