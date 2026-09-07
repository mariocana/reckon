import type { Address } from "viem";

export class GraphError extends Error {
  constructor(
    readonly product: "token-api" | "subgraph",
    message: string,
    readonly cause?: unknown
  ) {
    super(`[the-graph:${product}] ${message}`);
    this.name = "GraphError";
  }
}

export const GRAPH_NETWORK = "base" as const;

const TOKEN_API_URL = process.env.GRAPH_TOKEN_API_URL ?? "https://api.pinax.network/v1";
const GATEWAY_URL = process.env.GRAPH_GATEWAY_URL ?? "https://gateway.thegraph.com/api";
const UNISWAP_V3_BASE_SUBGRAPH =
  process.env.UNISWAP_V3_BASE_SUBGRAPH_ID ?? "HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1";

function gatewayKey(): string {
  const key = process.env.GRAPH_API_KEY;
  if (!key) {
    throw new GraphError("subgraph", "GRAPH_API_KEY is not set");
  }
  return key;
}

function tokenApiKey(): string {
  const key = process.env.GRAPH_TOKEN_API_KEY;
  if (!key) {
    throw new GraphError(
      "token-api",
      "GRAPH_TOKEN_API_KEY is not set — the Token API needs its own token, a Graph Studio key returns 401"
    );
  }
  return key;
}

export interface TokenMetadata {
  contract: Address;
  name: string;
  symbol: string;
  decimals: number;
  holders: number;
  circulatingSupply: number;
  lastUpdate: string;
}

interface TokenApiToken {
  contract: string;
  name: string;
  symbol: string;
  decimals: number;
  holders: number;
  circulating_supply: number;
  last_update: string;
}

interface TokenApiHolder {
  address: string;
  contract: string;
  amount: string;
  value: number;
  is_contract: boolean;
  decimals: number;
}

const TOKEN_API_ATTEMPTS = 4;

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 300 * 2 ** attempt));
}

async function tokenApi<T>(path: string, params: Record<string, string>): Promise<T[]> {
  const key = tokenApiKey();
  const url = new URL(`${TOKEN_API_URL}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastStatus = "";

  for (let attempt = 0; attempt < TOKEN_API_ATTEMPTS; attempt++) {
    if (attempt > 0) await backoff(attempt);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      });
    } catch (error) {
      lastStatus = "network error";
      if (attempt === TOKEN_API_ATTEMPTS - 1) {
        throw new GraphError("token-api", `request to ${path} failed`, error);
      }
      continue;
    }

    if (res.ok) {
      const body = (await res.json()) as { data?: T[] };
      return body.data ?? [];
    }

    lastStatus = `${res.status} ${res.statusText}`;

    if (res.status < 500) {
      throw new GraphError("token-api", `${path} returned ${lastStatus}`);
    }
  }

  throw new GraphError(
    "token-api",
    `${path} kept returning ${lastStatus} across ${TOKEN_API_ATTEMPTS} attempts`
  );
}

export async function getTokenMetadata(token: Address): Promise<TokenMetadata | null> {
  const [row] = await tokenApi<TokenApiToken>("/evm/tokens", {
    network: GRAPH_NETWORK,
    contract: token,
  });

  if (!row) return null;

  return {
    contract: row.contract as Address,
    name: row.name,
    symbol: row.symbol,
    decimals: row.decimals,
    holders: row.holders,
    circulatingSupply: row.circulating_supply,
    lastUpdate: row.last_update,
  };
}

export interface Holder {
  address: Address;
  amount: bigint;
  value: number;
  isContract: boolean;
}

export async function getTopHolders(token: Address, limit = 10): Promise<Holder[]> {
  const rows = await tokenApi<TokenApiHolder>("/evm/holders", {
    network: GRAPH_NETWORK,
    contract: token,
    limit: String(limit),
    page: "1",
  });

  return rows.map((r) => ({
    address: r.address as Address,
    amount: BigInt(r.amount),
    value: r.value,
    isContract: r.is_contract,
  }));
}

export async function querySubgraph<T>(
  query: string,
  variables: Record<string, unknown> = {},
  subgraphId: string = UNISWAP_V3_BASE_SUBGRAPH
): Promise<T> {
  const url = `${GATEWAY_URL}/${gatewayKey()}/subgraphs/id/${subgraphId}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
  } catch (error) {
    throw new GraphError("subgraph", "gateway request failed", error);
  }

  if (!res.ok) {
    throw new GraphError("subgraph", `gateway returned ${res.status} ${res.statusText}`);
  }

  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };

  if (body.errors?.length) {
    throw new GraphError("subgraph", body.errors.map((e) => e.message).join("; "));
  }
  if (!body.data) {
    throw new GraphError("subgraph", "gateway returned no data");
  }

  return body.data;
}

export interface PoolSummary {
  id: string;
  createdAtTimestamp: number;
  feeTier: number;
  totalValueLockedUSD: number;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
}

const POOLS_QUERY = `
  query Pools($token: String!, $first: Int!) {
    asToken0: pools(
      where: { token0: $token }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: $first
    ) {
      id
      createdAtTimestamp
      feeTier
      totalValueLockedUSD
      token0 { id symbol }
      token1 { id symbol }
    }
    asToken1: pools(
      where: { token1: $token }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: $first
    ) {
      id
      createdAtTimestamp
      feeTier
      totalValueLockedUSD
      token0 { id symbol }
      token1 { id symbol }
    }
  }
`;

interface RawPool {
  id: string;
  createdAtTimestamp: string;
  feeTier: string;
  totalValueLockedUSD: string;
  token0: { id: string; symbol: string };
  token1: { id: string; symbol: string };
}

export async function getPoolsForToken(token: Address, first = 10): Promise<PoolSummary[]> {
  const data = await querySubgraph<{ asToken0: RawPool[]; asToken1: RawPool[] }>(POOLS_QUERY, {
    token: token.toLowerCase(),
    first,
  });

  const seen = new Map<string, PoolSummary>();

  for (const p of [...data.asToken0, ...data.asToken1]) {
    seen.set(p.id, {
      id: p.id,
      createdAtTimestamp: Number(p.createdAtTimestamp),
      feeTier: Number(p.feeTier),
      totalValueLockedUSD: Number(p.totalValueLockedUSD),
      token0: p.token0,
      token1: p.token1,
    });
  }

  return [...seen.values()].sort((a, b) => b.totalValueLockedUSD - a.totalValueLockedUSD);
}

export interface PoolDay {
  date: number;
  tvlUSD: number;
  volumeUSD: number;
}

const POOL_DAYS_QUERY = `
  query PoolDays($pools: [String!]!, $since: Int!, $first: Int!) {
    poolDayDatas(
      where: { pool_in: $pools, date_gte: $since }
      orderBy: date
      orderDirection: asc
      first: $first
    ) {
      date
      pool { id }
      tvlUSD
      volumeUSD
    }
  }
`;

interface RawPoolDay {
  date: number;
  pool: { id: string };
  tvlUSD: string;
  volumeUSD: string;
}

export async function getPoolDays(
  poolIds: string[],
  sinceUnix: number,
  first = 1000
): Promise<Map<string, PoolDay[]>> {
  if (poolIds.length === 0) return new Map();

  const data = await querySubgraph<{ poolDayDatas: RawPoolDay[] }>(POOL_DAYS_QUERY, {
    pools: poolIds.map((id) => id.toLowerCase()),
    since: sinceUnix,
    first,
  });

  const byPool = new Map<string, PoolDay[]>();

  for (const row of data.poolDayDatas) {
    const list = byPool.get(row.pool.id) ?? [];
    list.push({
      date: row.date,
      tvlUSD: Number(row.tvlUSD),
      volumeUSD: Number(row.volumeUSD),
    });
    byPool.set(row.pool.id, list);
  }

  return byPool;
}

const PAIR_POOLS_QUERY = `
  query PairPools($tokenA: String!, $tokenB: String!) {
    forward: pools(
      where: { token0: $tokenA, token1: $tokenB }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: 5
    ) { id createdAtTimestamp feeTier totalValueLockedUSD token0 { id symbol } token1 { id symbol } }
    reverse: pools(
      where: { token0: $tokenB, token1: $tokenA }
      orderBy: totalValueLockedUSD
      orderDirection: desc
      first: 5
    ) { id createdAtTimestamp feeTier totalValueLockedUSD token0 { id symbol } token1 { id symbol } }
  }
`;

export async function getBestPoolForPair(
  tokenA: Address,
  tokenB: Address
): Promise<PoolSummary | null> {
  const data = await querySubgraph<{ forward: RawPool[]; reverse: RawPool[] }>(PAIR_POOLS_QUERY, {
    tokenA: tokenA.toLowerCase(),
    tokenB: tokenB.toLowerCase(),
  });

  const pools = [...data.forward, ...data.reverse]
    .map((p) => ({
      id: p.id,
      createdAtTimestamp: Number(p.createdAtTimestamp),
      feeTier: Number(p.feeTier),
      totalValueLockedUSD: Number(p.totalValueLockedUSD),
      token0: p.token0,
      token1: p.token1,
    }))
    .sort((a, b) => b.totalValueLockedUSD - a.totalValueLockedUSD);

  return pools[0] ?? null;
}
