import {
  hashTypedData,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { z } from "zod";
import type { ProposedAction } from "@/lib/types";
import { MANDATE_EIP712_DOMAIN, type Mandate } from "./schema";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/) as z.ZodType<Address>;

export const overrideSchema = z.object({
  mandateHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) as z.ZodType<Hex>,
  owner: address,
  agent: address,
  token: address,
  kind: z.enum(["buy", "sell"]),
  maxAmountUsd: z.number().positive(),
  venue: z.enum(["1inch-aqua", "uniswap", "0x"]),
  clauses: z.array(z.string()).min(1),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonce: z.string(),
});

export type Override = z.infer<typeof overrideSchema>;

export const OVERRIDE_EIP712_TYPES = {
  Override: [
    { name: "mandateHash", type: "bytes32" },
    { name: "owner", type: "address" },
    { name: "agent", type: "address" },
    { name: "token", type: "address" },
    { name: "kind", type: "string" },
    { name: "maxAmountUsd", type: "uint256" },
    { name: "venue", type: "string" },
    { name: "clauses", type: "string" },
    { name: "issuedAt", type: "uint256" },
    { name: "expiresAt", type: "uint256" },
    { name: "nonce", type: "string" },
  ],
} as const;

const unix = (iso: string) => BigInt(Math.floor(new Date(iso).getTime() / 1000));

export function overrideTypedData(o: Override, chainId: number) {
  return {
    domain: { ...MANDATE_EIP712_DOMAIN, chainId },
    types: OVERRIDE_EIP712_TYPES,
    primaryType: "Override" as const,
    message: {
      mandateHash: o.mandateHash,
      owner: o.owner,
      agent: o.agent,
      token: o.token,
      kind: o.kind,
      maxAmountUsd: BigInt(Math.round(o.maxAmountUsd * 100)),
      venue: o.venue,
      clauses: o.clauses.join(","),
      issuedAt: unix(o.issuedAt),
      expiresAt: unix(o.expiresAt),
      nonce: o.nonce,
    },
  };
}

export function overrideHash(o: Override, chainId: number): Hex {
  return hashTypedData(overrideTypedData(o, chainId));
}

export function describeOverride(o: Override): string {
  return [
    `The owner authorises one action outside the mandate.`,
    `Agent ${o.agent} may ${o.kind} up to $${o.maxAmountUsd} of ${o.token} on ${o.venue}.`,
    `Clauses waived for this action only: ${o.clauses.join(", ")}.`,
    `Valid until ${o.expiresAt}. Nonce ${o.nonce}.`,
    `Bound to mandate ${o.mandateHash}.`,
  ].join("\n");
}

export interface SignedOverride {
  override: Override;
  signature: Hex;
}

export type OverrideCheck =
  | { ok: true; hash: Hex }
  | { ok: false; reason: string };

export async function verifyOverride(
  signed: SignedOverride,
  mandate: Mandate,
  mandateDigest: Hex,
  action: ProposedAction,
  now: Date,
  usedNonces: Set<string> = new Set()
): Promise<OverrideCheck> {
  const { override: o, signature } = signed;

  if (o.mandateHash !== mandateDigest) {
    return { ok: false, reason: "the override is bound to a different mandate" };
  }
  if (o.agent.toLowerCase() !== mandate.agent.toLowerCase()) {
    return { ok: false, reason: "the override names a different agent" };
  }
  if (o.token.toLowerCase() !== action.token.toLowerCase()) {
    return { ok: false, reason: `the override covers ${o.token}, not ${action.token}` };
  }
  if (o.kind !== action.kind) {
    return { ok: false, reason: `the override covers ${o.kind}, not ${action.kind}` };
  }
  if (o.venue !== action.venue) {
    return { ok: false, reason: `the override covers ${o.venue}, not ${action.venue}` };
  }
  if (action.amountUsd > o.maxAmountUsd) {
    return { ok: false, reason: `the override allows up to $${o.maxAmountUsd}, the action is $${action.amountUsd}` };
  }
  if (now >= new Date(o.expiresAt)) {
    return { ok: false, reason: "the override has expired" };
  }
  if (now < new Date(o.issuedAt)) {
    return { ok: false, reason: "the override is not yet valid" };
  }
  if (usedNonces.has(o.nonce)) {
    return { ok: false, reason: `nonce ${o.nonce} has already been used` };
  }

  let recovered: Address;
  try {
    recovered = await recoverTypedDataAddress({
      ...overrideTypedData(o, mandate.chainId),
      signature,
    });
  } catch {
    return { ok: false, reason: "the signature could not be recovered" };
  }

  if (recovered.toLowerCase() !== mandate.owner.toLowerCase()) {
    return { ok: false, reason: `signed by ${recovered}, but the mandate's owner is ${mandate.owner}` };
  }

  return { ok: true, hash: overrideHash(o, mandate.chainId) };
}
