import { parseAbi, parseUnits, type Address, type PublicClient } from "viem";
import { getTokenRisk } from "@/lib/data/risk";
import { readPortfolio, type TrackedToken } from "@/lib/data/portfolio";
import { evaluate } from "@/lib/mandate/evaluate";
import { mandateHash, type Mandate } from "@/lib/mandate/schema";
import { UNISWAP_ADDRESSES, UniswapVenue, type UniswapQuoteDetail } from "@/lib/exec/uniswap";
import type { Signer } from "@/lib/exec/venue";
import { appendReceipt, nextReceiptId } from "@/lib/receipts/store";
import type { Authorization, Execution, Observation, Receipt } from "@/lib/receipts/types";
import type { ProposedAction, TokenRisk } from "@/lib/types";
import { verifyOverride, type SignedOverride } from "@/lib/mandate/override";
import { compileMandateToPolicy, type CompileOptions } from "@/lib/exec/privy";

const erc20 = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
]);

export interface CycleInput {
  client: PublicClient;
  signer: Signer;
  mandate: Mandate;
  proposal: ProposedAction;
  trigger: string;
  stables: Address[];
  tracked: TrackedToken[];
  spendToken: Address;
  lastTradeAt?: Date;
  persist?: boolean;
  override?: SignedOverride;
  policyAdmin?: PolicyAdmin;
}

export interface PolicyAdmin {
  walletId: string;
  basePolicyId: string;
  compileOptions: CompileOptions;
  createPolicy(input: { name: string; chain_type: "ethereum"; version: "1.0"; rules: unknown[] }): Promise<string>;
  attachPolicy(walletId: string, policyIds: string[]): Promise<void>;
}

export async function runCycle(input: CycleInput): Promise<Receipt> {
  const { client, signer, mandate, proposal, stables, tracked, spendToken } = input;

  const portfolio = await readPortfolio(client, signer.address, tracked, spendToken);

  let risk: TokenRisk | null = null;
  let poolsSeen = 0;
  let bestPoolTvlUsd: number | null = null;

  const needsRisk = proposal.kind === "buy" && !stables.some((s) => s.toLowerCase() === proposal.token.toLowerCase());

  if (needsRisk) {
    try {
      const evidence = await getTokenRisk(proposal.token);
      risk = evidence.risk;
      poolsSeen = evidence.pools.length;
      bestPoolTvlUsd = evidence.pools[0]?.totalValueLockedUSD ?? null;
    } catch {
      risk = null;
    }
  }

  const observation: Observation = {
    source: "thegraph",
    queriedAt: new Date().toISOString(),
    risk,
    poolsSeen,
    bestPoolTvlUsd,
  };

  const verdict = evaluate(mandate, proposal, {
    portfolio,
    risk: risk ?? undefined,
    stables,
    now: new Date(),
    lastTradeAt: input.lastTradeAt,
  });

  let authorization: Authorization = {
    layer: "none",
    outcome: "refused",
    signer: null,
    detail: "the mandate refuses this action",
  };
  let execution: Execution | null = null;

  let widened = false;

  if (verdict.kind === "escalate") {
    authorization = {
      layer: "human-escalation",
      outcome: "pending",
      signer: mandate.owner,
      detail: "beyond the mandate — the owner has to authorise it",
    };

    if (input.override) {
      const check = await verifyOverride(
        input.override,
        mandate,
        mandateHash(mandate),
        proposal,
        new Date()
      );

      if (!check.ok) {
        authorization = {
          layer: "human-escalation",
          outcome: "refused",
          signer: mandate.owner,
          detail: `override rejected: ${check.reason}`,
        };
      } else if (!input.policyAdmin) {
        authorization = {
          layer: "human-escalation",
          outcome: "refused",
          signer: mandate.owner,
          detail: "override is valid but the wallet policy cannot be widened without admin access",
        };
      } else {
        const admin = input.policyAdmin;
        const compiled = compileMandateToPolicy(mandate, admin.compileOptions, [input.override.override]);
        const widenedId = await admin.createPolicy({
          name: compiled.name,
          chain_type: compiled.chain_type,
          version: compiled.version,
          rules: compiled.rules,
        });
        await admin.attachPolicy(admin.walletId, [widenedId]);
        widened = true;

        authorization = {
          layer: "human-escalation",
          outcome: "granted",
          signer: mandate.owner,
          detail: `override ${check.hash.slice(0, 14)}… signed by the owner; policy widened for this action`,
        };
      }
    }
  }

  const shouldExecute = verdict.kind === "allow" || widened;

  if (shouldExecute) {
    const decimals = await client.readContract({
      address: spendToken,
      abi: erc20,
      functionName: "decimals",
    });
    const sellAmount = parseUnits(String(proposal.amountUsd), decimals);

    const venue = new UniswapVenue(client);
    const quote = await venue.quote({
      sellToken: spendToken,
      buyToken: proposal.token,
      sellAmount,
      slippageBps: 100,
      taker: signer.address,
    });
    const detail = quote.raw as UniswapQuoteDetail;

    try {
      const allowance = await client.readContract({
        address: spendToken,
        abi: erc20,
        functionName: "allowance",
        args: [signer.address, UNISWAP_ADDRESSES.swapRouter02],
      });

      const result = await venue.execute(quote, signer);

      if (!widened) {
        authorization = {
          layer: "privy-policy",
          outcome: "granted",
          signer: signer.address,
          detail:
            allowance < sellAmount
              ? "the policy allowed the approval and the swap"
              : "the policy allowed the swap",
        };
      }

      execution = {
        venue: "uniswap",
        txHash: result.txHash,
        feeTier: detail.feeTier,
        sellAmount: sellAmount.toString(),
        buyAmount: quote.buyAmount.toString(),
        minBuyAmount: quote.minBuyAmount.toString(),
        status: "success",
      };
    } catch (error) {
      const message = String((error as Error).message).split("\n")[0];
      authorization = {
        layer: widened ? "human-escalation" : "privy-policy",
        outcome: "refused",
        signer: signer.address,
        detail: /policy_violation/i.test(message)
          ? "the wallet policy refused to sign"
          : message.slice(0, 160),
      };
    } finally {
      if (widened && input.policyAdmin) {
        await input.policyAdmin.attachPolicy(input.policyAdmin.walletId, [
          input.policyAdmin.basePolicyId,
        ]);
      }
    }
  }

  const receipt: Receipt = {
    id: nextReceiptId(),
    createdAt: new Date().toISOString(),
    mandateHash: mandateHash(mandate),
    trigger: input.trigger,
    observation,
    proposal: {
      kind: proposal.kind,
      token: proposal.token,
      symbol: proposal.symbol,
      amountUsd: proposal.amountUsd,
      venue: proposal.venue,
      rationale: proposal.rationale,
    },
    verdict,
    authorization,
    execution,
    outcome: null,
  };

  if (input.persist !== false) appendReceipt(receipt);

  return receipt;
}
