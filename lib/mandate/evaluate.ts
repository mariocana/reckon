import type { Address } from "viem";
import type { Portfolio, ProposedAction, TokenRisk } from "@/lib/types";
import { mandateHash, type ClauseId, type Mandate } from "./schema";

export type Severity = "hard" | "soft";

export interface Violation {
  clause: ClauseId;
  severity: Severity;
  explain: string;
  observed: string;
  limit: string;
}

export type Verdict =
  | { kind: "allow"; mandateHash: `0x${string}`; checked: ClauseId[] }
  | {
      kind: "deny" | "escalate";
      mandateHash: `0x${string}`;
      checked: ClauseId[];
      violations: Violation[];
    };

export interface EvaluationContext {
  portfolio: Portfolio;
  risk?: TokenRisk;
  stables: Address[];
  now: Date;
  lastTradeAt?: Date;
}

const ALL_CLAUSES: ClauseId[] = [
  "§0.validity",
  "§1.reserve",
  "§2.concentration",
  "§3.tradeSize",
  "§4.universe",
  "§5.cadence",
  "§6.venue",
];

const pct = (n: number) => `${n.toFixed(2)}%`;
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function sameAddress(a: Address, b: Address): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function valueOf(portfolio: Portfolio, token: Address): number {
  return portfolio.positions
    .filter((p) => sameAddress(p.token, token))
    .reduce((sum, p) => sum + p.valueUsd, 0);
}

function stableValue(portfolio: Portfolio, stables: Address[]): number {
  return portfolio.positions
    .filter((p) => p.isStable || stables.some((s) => sameAddress(s, p.token)))
    .reduce((sum, p) => sum + p.valueUsd, 0);
}

export function evaluate(
  mandate: Mandate,
  action: ProposedAction,
  ctx: EvaluationContext
): Verdict {
  const hash = mandateHash(mandate);
  const violations: Violation[] = [];
  const c = mandate.clauses;
  const { portfolio, stables, now } = ctx;

  const issuedAt = new Date(mandate.issuedAt);
  const expiresAt = new Date(mandate.expiresAt);

  if (now >= expiresAt) {
    violations.push({
      clause: "§0.validity",
      severity: "hard",
      explain: "The mandate has expired. The owner must issue a new one.",
      observed: now.toISOString(),
      limit: mandate.expiresAt,
    });
  } else if (now < issuedAt) {
    violations.push({
      clause: "§0.validity",
      severity: "hard",
      explain: "The mandate is not yet in force.",
      observed: now.toISOString(),
      limit: mandate.issuedAt,
    });
  }

  if (portfolio.totalValueUsd <= 0) {
    violations.push({
      clause: "§0.validity",
      severity: "hard",
      explain: "The treasury is empty — no action can be sized against it.",
      observed: usd(portfolio.totalValueUsd),
      limit: "> $0",
    });
    return { kind: "deny", mandateHash: hash, checked: ALL_CLAUSES, violations };
  }

  const total = portfolio.totalValueUsd;
  const targetIsStable = stables.some((s) => sameAddress(s, action.token));
  const signed = action.kind === "buy" ? action.amountUsd : -action.amountUsd;

  const projectedStable = stableValue(portfolio, stables) - signed;
  const projectedStablePct = (projectedStable / total) * 100;

  if (projectedStablePct < c.reserve.minStablePct) {
    violations.push({
      clause: "§1.reserve",
      severity: "soft",
      explain: `The action would leave the treasury at ${pct(projectedStablePct)} in stablecoins, below the reserve floor.`,
      observed: pct(projectedStablePct),
      limit: `>= ${pct(c.reserve.minStablePct)}`,
    });
  }

  if (!targetIsStable) {
    const projectedPosition = valueOf(portfolio, action.token) + signed;
    const projectedPct = (projectedPosition / total) * 100;

    if (projectedPct > c.concentration.maxSingleAssetPct) {
      violations.push({
        clause: "§2.concentration",
        severity: "soft",
        explain: `The action would put ${pct(projectedPct)} of the treasury into ${action.symbol}, above the single-asset ceiling.`,
        observed: pct(projectedPct),
        limit: `<= ${pct(c.concentration.maxSingleAssetPct)}`,
      });
    }
  }

  if (action.amountUsd > c.tradeSize.maxPerTradeUsd) {
    violations.push({
      clause: "§3.tradeSize",
      severity: "soft",
      explain: `The action is larger than a single trade is allowed to be.`,
      observed: usd(action.amountUsd),
      limit: `<= ${usd(c.tradeSize.maxPerTradeUsd)}`,
    });
  }

  if (action.kind === "buy" && !targetIsStable) {
    const risk = ctx.risk;

    if (!risk) {
      violations.push({
        clause: "§4.universe",
        severity: "hard",
        explain: `No historical data for ${action.symbol}, so §4 cannot be cleared. Unverified means denied.`,
        observed: "no data",
        limit: "verified token history",
      });
    } else {
      if (risk.ageDays < c.universe.minTokenAgeDays) {
        violations.push({
          clause: "§4.universe",
          severity: "hard",
          explain: `${action.symbol} first traded ${risk.ageDays.toFixed(0)} days ago and is too young to enter.`,
          observed: `${risk.ageDays.toFixed(0)} days`,
          limit: `>= ${c.universe.minTokenAgeDays} days`,
        });
      }

      if (risk.sustainedLiquidityUsd < c.universe.minSustainedLiquidityUsd) {
        violations.push({
          clause: "§4.universe",
          severity: "hard",
          explain: `${action.symbol} liquidity fell to ${usd(risk.sustainedLiquidityUsd)} within the window — thinner than the mandate allows.`,
          observed: usd(risk.sustainedLiquidityUsd),
          limit: `>= ${usd(c.universe.minSustainedLiquidityUsd)}`,
        });
      }

      const concentration = risk.holderConcentrationExContractsPct;

      if (concentration === null) {
        if (c.universe.maxHolderConcentrationPct < 100) {
          violations.push({
            clause: "§4.universe",
            severity: "hard",
            explain: `Holder concentration for ${action.symbol} could not be measured, and the mandate sets a limit on it.`,
            observed: "not measured",
            limit: `<= ${pct(c.universe.maxHolderConcentrationPct)}`,
          });
        }
      } else if (concentration > c.universe.maxHolderConcentrationPct) {
        const raw =
          risk.holderConcentrationPct !== null && risk.contractsInTopHolders > 0
            ? ` (${pct(risk.holderConcentrationPct)} if the ${risk.contractsInTopHolders} contracts among them are counted)`
            : "";
        violations.push({
          clause: "§4.universe",
          severity: "hard",
          explain: `Wallets among the top 10 hold ${pct(concentration)} of ${action.symbol}${raw}.`,
          observed: pct(concentration),
          limit: `<= ${pct(c.universe.maxHolderConcentrationPct)}`,
        });
      }
    }
  }

  if (ctx.lastTradeAt) {
    const elapsed = (now.getTime() - ctx.lastTradeAt.getTime()) / 1000;
    if (elapsed < c.cadence.minSecondsBetweenTrades) {
      violations.push({
        clause: "§5.cadence",
        severity: "hard",
        explain: `Only ${elapsed.toFixed(0)}s since the last trade.`,
        observed: `${elapsed.toFixed(0)}s`,
        limit: `>= ${c.cadence.minSecondsBetweenTrades}s`,
      });
    }
  }

  if (!c.venues.allowed.includes(action.venue)) {
    violations.push({
      clause: "§6.venue",
      severity: "hard",
      explain: `${action.venue} is not an authorised venue.`,
      observed: action.venue,
      limit: c.venues.allowed.join(", "),
    });
  }

  if (violations.length === 0) {
    return { kind: "allow", mandateHash: hash, checked: ALL_CLAUSES };
  }

  const kind = violations.some((v) => v.severity === "hard") ? "deny" : "escalate";
  return { kind, mandateHash: hash, checked: ALL_CLAUSES, violations };
}

export function describeVerdict(v: Verdict): string {
  if (v.kind === "allow") return "allow — every clause cleared";

  const head = v.kind === "deny" ? "deny" : "escalate";
  const clauses = [...new Set(v.violations.map((x) => x.clause))].join(", ");
  return `${head} — ${clauses}`;
}
