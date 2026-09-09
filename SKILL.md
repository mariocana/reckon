---
name: token-risk-gate
description: Decide whether a token is safe to buy, using historical on-chain evidence from The Graph rather than a spot price. Answers three questions a price feed cannot - how old is this token, was its liquidity ever real, and who actually holds it. Use before committing capital to any ERC-20 on Base.
---

# Token risk gate

Turns a token address into a verdict backed by evidence, so an agent can be stopped before it buys something it should not.

A price API tells you what a token costs right now. It cannot tell you that the pool was drained to $40k last Tuesday, that the token first traded six days ago, or that nine of its ten largest holders are one person. Those are historical questions, and they are the ones that decide whether capital should move.

## When to use this

Before any buy. Not before a sell — an existing position must always be exitable, even if the token has since drifted out of the investable universe, otherwise the rule traps the treasury in exactly the asset it distrusts.

## What it answers

| question | source | why the obvious answer is wrong |
|---|---|---|
| How old is it? | Uniswap v3 subgraph, `createdAtTimestamp` of the oldest pool | Token contracts can predate trading; the first pool is when it became tradeable |
| Was the liquidity real? | Uniswap v3 subgraph, the **minimum** of `poolDayDatas.tvlUSD` across the window | An average hides the day it was drained. Use the trough |
| Who holds it? | Token API, top 10 holders over circulating supply | Bridges and protocol contracts dominate the top 10 of any wrapped asset. Count wallets, not addresses |

## Using it

```ts
import { getTokenRisk } from "@/lib/data/risk";

const { risk, pools, liquidityByDay } = await getTokenRisk(token);

risk.ageDays                              // 1127
risk.sustainedLiquidityUsd                // 154_925_964  — the trough, not today
risk.holderConcentrationPct               // 52.24  — every top-10 address
risk.holderConcentrationExContractsPct    // 0.93   — wallets only
risk.contractsInTopHolders                // 9
```

`RiskEvidence` carries the pools and the daily liquidity series alongside the verdict inputs. Return the evidence, not just the number — whoever reads the decision later needs to see what it rested on.

Then gate on it:

```ts
import { evaluate } from "@/lib/mandate/evaluate";

const verdict = evaluate(mandate, action, { portfolio, risk, stables, now });
// { kind: "deny", violations: [{ clause: "§4.universe", severity: "hard", ... }] }
```

## Rules this skill follows

**Unverified means denied.** If the historical data cannot be fetched, the answer is no. A risk gate that fails open is not a risk gate. `holderConcentrationExContractsPct` comes back `null` when the Token API is unreachable, and the evaluator treats that as a hard violation whenever the mandate sets a limit on it.

**Report every breach, not the first.** A token can be too young *and* too thin *and* too concentrated. Bailing at the first failure hides the shape of the problem from whoever reads the receipt.

**Cache, and prefer stale over absent.** The Token API returns 500 on roughly one call in five. A gate that denies because of someone else's flaky infrastructure is a gate that will deny at the worst possible moment. Results are cached for 15 minutes and a failed refresh falls back to the last good answer rather than to `null`.

**Compare against a written limit.** Every violation carries `observed` and `limit` as formatted strings. "78.00% held by wallets, allowed <= 40.00%" is auditable. "risky" is not.

## Two credentials, not one

The Graph gateway and the Token API authenticate separately:

```
GRAPH_API_KEY          gateway.thegraph.com — subgraph queries
GRAPH_TOKEN_API_KEY    api.pinax.network    — a JWT, starts with eyJ
```

A Graph Studio key returns 401 against the Token API. The Token API also intermittently returns 500 on valid requests; retry with backoff.

## Subgraph caveat

The Uniswap v3 Base deployments on the decentralised network are community-run, and Uniswap notes they are not official. TVL for exotic pairs can be nonsense — one WETH pool reports $34bn. Aggregate across pools and take minimums; do not trust a single pool's headline number.

Configure a different deployment with `UNISWAP_V3_BASE_SUBGRAPH_ID`.
