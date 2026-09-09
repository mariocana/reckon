import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Address } from "viem";
import type { TokenRisk } from "@/lib/types";
import {
  GraphError,
  getPoolDays,
  getPoolsForToken,
  getTokenMetadata,
  getTopHolders,
  type PoolDay,
  type PoolSummary,
} from "./graph";

export interface RiskOptions {
  windowDays?: number;
  topHolders?: number;
  maxPools?: number;
  cacheTtlMs?: number;
  cacheFile?: string;
  refresh?: boolean;
}

const CACHE_FILE = process.env.RECKON_RISK_CACHE ?? "data/risk-cache.json";
const CACHE_TTL_MS = 15 * 60 * 1000;

type CacheEntry = { storedAt: number; evidence: RiskEvidence };

function loadCache(file: string): Record<string, CacheEntry> {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function saveCache(file: string, cache: Record<string, CacheEntry>): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(cache, null, 2));
}

export interface RiskEvidence {
  risk: TokenRisk;
  pools: PoolSummary[];
  oldestPoolCreatedAt: number;
  liquidityByDay: Array<{ date: number; tvlUSD: number }>;
  circulatingSupply: number | null;
  concentrationExcludingContractsPct: number | null;
  contractHolders: number;
  concentrationUnavailable?: string;
}

const DAY = 86_400;

export function troughLiquidity(days: Array<{ tvlUSD: number }>): number {
  if (days.length === 0) return 0;
  return days.reduce((min, d) => (d.tvlUSD < min ? d.tvlUSD : min), Infinity);
}

function aggregateByDate(byPool: Map<string, PoolDay[]>): Array<{ date: number; tvlUSD: number }> {
  const totals = new Map<number, number>();

  for (const days of byPool.values()) {
    for (const d of days) {
      totals.set(d.date, (totals.get(d.date) ?? 0) + d.tvlUSD);
    }
  }

  return [...totals.entries()]
    .map(([date, tvlUSD]) => ({ date, tvlUSD }))
    .sort((a, b) => a.date - b.date);
}

function symbolFromPools(token: Address, pools: PoolSummary[]): string {
  const lower = token.toLowerCase();
  for (const p of pools) {
    if (p.token0.id.toLowerCase() === lower) return p.token0.symbol;
    if (p.token1.id.toLowerCase() === lower) return p.token1.symbol;
  }
  return "?";
}

export async function getTokenRisk(
  token: Address,
  options: RiskOptions = {}
): Promise<RiskEvidence> {
  const cacheFile = options.cacheFile ?? CACHE_FILE;
  const ttl = options.cacheTtlMs ?? CACHE_TTL_MS;
  const key = token.toLowerCase();
  const cache = loadCache(cacheFile);
  const hit = cache[key];

  if (!options.refresh && hit && Date.now() - hit.storedAt < ttl) {
    return hit.evidence;
  }

  try {
    const fresh = await fetchTokenRisk(token, options);
    if (fresh.risk.holderConcentrationExContractsPct !== null || !hit) {
      cache[key] = { storedAt: Date.now(), evidence: fresh };
      saveCache(cacheFile, cache);
      return fresh;
    }
    return hit.evidence;
  } catch (error) {
    if (hit) return hit.evidence;
    throw error;
  }
}

async function fetchTokenRisk(
  token: Address,
  options: RiskOptions
): Promise<RiskEvidence> {
  const windowDays = options.windowDays ?? 30;
  const topN = options.topHolders ?? 10;
  const maxPools = options.maxPools ?? 10;

  const pools = await getPoolsForToken(token, maxPools);

  if (pools.length === 0) {
    throw new GraphError("subgraph", `no Uniswap v3 pools found for ${token} on Base`);
  }

  const oldestPoolCreatedAt = pools.reduce(
    (min, p) => (p.createdAtTimestamp > 0 && p.createdAtTimestamp < min ? p.createdAtTimestamp : min),
    Number.POSITIVE_INFINITY
  );

  const now = Math.floor(Date.now() / 1000);
  const ageDays = Number.isFinite(oldestPoolCreatedAt) ? (now - oldestPoolCreatedAt) / DAY : 0;

  const byPool = await getPoolDays(
    pools.map((p) => p.id),
    now - windowDays * DAY
  );

  const liquidityByDay = aggregateByDate(byPool);
  const sustainedLiquidityUsd = troughLiquidity(liquidityByDay);

  let holderConcentrationPct: number | null = null;
  let concentrationExcludingContractsPct: number | null = null;
  let contractHolders = 0;
  let circulatingSupply: number | null = null;
  let concentrationUnavailable: string | undefined;

  try {
    const [metadata, holders] = await Promise.all([
      getTokenMetadata(token),
      getTopHolders(token, topN),
    ]);

    if (metadata && metadata.circulatingSupply > 0) {
      circulatingSupply = metadata.circulatingSupply;
      const scale = 10 ** metadata.decimals;
      const share = (amount: bigint) => Number(amount) / scale / metadata.circulatingSupply;

      holderConcentrationPct = Math.min(
        100,
        holders.reduce((sum, h) => sum + share(h.amount), 0) * 100
      );

      const people = holders.filter((h) => !h.isContract);
      contractHolders = holders.length - people.length;
      concentrationExcludingContractsPct = Math.min(
        100,
        people.reduce((sum, h) => sum + share(h.amount), 0) * 100
      );
    } else {
      concentrationUnavailable = "the Token API returned no supply for this token";
    }
  } catch (error) {
    concentrationUnavailable =
      error instanceof GraphError ? error.message : "the Token API call failed";
  }

  const risk: TokenRisk = {
    token,
    symbol: symbolFromPools(token, pools),
    firstSeenAt: Number.isFinite(oldestPoolCreatedAt)
      ? new Date(oldestPoolCreatedAt * 1000).toISOString()
      : new Date(0).toISOString(),
    ageDays,
    sustainedLiquidityUsd,
    holderConcentrationPct,
    holderConcentrationExContractsPct: concentrationExcludingContractsPct,
    contractsInTopHolders: contractHolders,
    source: "thegraph",
    queriedAt: new Date().toISOString(),
  };

  return {
    risk,
    pools,
    oldestPoolCreatedAt,
    liquidityByDay,
    circulatingSupply,
    concentrationExcludingContractsPct,
    contractHolders,
    concentrationUnavailable,
  };
}
