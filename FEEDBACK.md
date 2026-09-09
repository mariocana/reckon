# Feedback

Notes from building reckon on Base over one hackathon. Written as we hit things, not reconstructed afterwards.

---

## Uniswap

We use the v3 subgraph for risk data and `SwapRouter02` + `QuoterV2` for execution.

### Highest TVL is not the best price, and the docs let you assume it is

Our first execution path asked the subgraph for the pair's highest-TVL pool and quoted that tier. It worked, and it was quietly costing us money.

Quoting all four tiers in parallel instead:

```
$100 USDC → WETH
  0.01%  0.040318      ← best
  0.05%  0.040298
  0.3%   0.040094      ← the highest-TVL pool, $124M
  1%     0.039598

$5,000 USDC → WETH
  0.05%  2.014708      ← best, the winner flips here
  0.01%  2.014087
  0.3%   2.004698
```

About 0.6% worse on small trades, with the crossover around $5,000. This is obvious in hindsight and was not obvious while writing the code — the subgraph gives you `totalValueLockedUSD` right there in the pool query, and reaching for it feels like the informed choice.

A line in the subgraph or router docs saying "pool depth ranks candidates; it does not price them — quote every tier" would have saved us the mistake. Four `quoteExactInputSingle` calls are cheap and can run in parallel.

### Community subgraph deployments report broken TVL

Querying pools for WETH on Base, the top result by `totalValueLockedUSD` is a WETH/🧢 pool reporting **$33,998,209,976**. Thirty-four billion dollars.

The Uniswap docs correctly note that Explorer deployments are not official and may be unmaintained, but in practice there is no signposted alternative for Base, so everyone lands on a community deployment and inherits its data quality. We had to aggregate across pools and take minimums to get anything trustworthy.

Two things would help:
- A canonical, maintained subgraph ID per chain in the Uniswap docs, rather than leaving discovery to search
- Any sanity bound on `totalValueLockedUSD` in the subgraph mappings — a pool reporting more TVL than the chain holds is a data bug worth catching at index time

We ended up making the deployment configurable (`UNISWAP_V3_BASE_SUBGRAPH_ID`) because we could not tell which one to trust.

### `poolDayDatas` is the most useful thing in the subgraph and the least documented

Our token risk gate turns on the *trough* of daily TVL over 30 days, not the spot figure. A pool that dipped to $40k for one day is not liquid, however healthy it looks today, and an average hides exactly that.

`poolDayDatas` makes this a single query, and we found it by reading the schema rather than the docs. A worked example of "was this liquidity ever real" would sell the subgraph better than another price-fetch snippet — it is the question that spot APIs cannot answer, which is the whole reason to use a subgraph at all.

### `SwapRouter02` dropping `deadline` from the params struct

Minor, but it cost us a compile error and a doc hunt. Plenty of tutorials still show the v1 struct with `deadline` inside `ExactInputSingleParams`. Worth a deprecation note near the top of the router docs rather than only in the changelog.

### What went well

`QuoterV2` reverting internally and being called through `simulateContract` is unusual, and viem handles it cleanly — the `stateMutability: nonpayable` quirk was the only surprise and the error message pointed straight at it. Fee tiers as a small fixed set makes exhaustive quoting trivial. Contract addresses on Base were correct in the docs and verified on the first try, which is rarer than it should be.

---

## The Graph

We compose two products: the Uniswap v3 subgraph via the gateway, and the Token API for holder data.

### The two credentials are not interchangeable, and the error does not say so

`GRAPH_API_KEY` from Graph Studio works against `gateway.thegraph.com`. Against the Token API it returns:

```json
{"error":{"status":401,"code":"unauthorized"}}
```

No `WWW-Authenticate` header, no hint that the credential type is wrong. We spent a while assuming the key was revoked and regenerated it before working out that the Token API needs its own JWT from Pinax.

The docs say "a Bearer JWT issued from your project key", which is accurate but reads like the key *is* the JWT. The tell is the shape — a JWT starts with `eyJ` and has two dots; our Studio key was 48 hex characters. A 401 body naming the expected credential would have collapsed an hour into a minute.

### `token-api.thegraph.com` does not resolve

The Token API launch post gives the base URL as `https://token-api.thegraph.com/v1`. That host does not resolve — connection fails outright, no DNS. The working host is `https://api.pinax.network/v1`, which you only find by following the docs redirect from `thegraph.com/docs/en/token-api/...` to `app.pinax.network/docs/api/...`.

### The Token API returns 500 on valid requests, roughly one call in five

Measured directly, same request repeated:

```
500 200 200 200 200
```

Both `/v1/evm/tokens` and `/v1/evm/holders`, on `network=base`, with a valid JWT. The 500 body carries no detail. Adding `page=1` seemed to help at first and then did not — it is intermittent, not parameter-dependent.

This bit us in a way worth describing, because it is the failure mode that matters for agents. Our risk gate fails closed: no holder data means the clause cannot be cleared, so the action is denied. Correct behaviour, but it meant a flaky third-party 500 turned into "the agent refuses to trade" — three denials in a row during a demo run, for a reason that had nothing to do with the token.

We now retry with backoff and cache for 15 minutes, preferring a stale answer over `null`. But an agent gating capital on this API needs to know its error rate up front. A status page, or documented retry guidance, would help more than another endpoint.

### `is_contract` on the holders endpoint is the best thing in the API

The top 10 WETH holders on Base control **52.2%** of supply. Nine of the ten are bridges and protocol contracts. Actual wallets hold **0.93%**.

Naive top-10 concentration rejects WETH as dangerously concentrated. It is exactly backwards, and `is_contract` is what makes the distinction possible — we would have shipped the wrong metric without it.

It deserves more prominence than a field in the response table. "Filter contracts before computing concentration" is the kind of guidance that turns a raw endpoint into a correct answer, and it is the sort of thing only the people who built the index know.

### What went well

Composing the two products was genuinely easy once the credentials were sorted, and the split is natural: the subgraph knows about pools and time, the Token API knows about supply and holders. Neither could answer §4 alone.

Gateway latency was consistently good. Subgraph GraphQL aliases let us fetch `token0`/`token1` orderings in one round trip. And the decentralised network meant we never had to run infrastructure to ask historical questions, which for a four-day build was the difference between doing this and not.

---

## 1inch Aqua

We targeted Aqua as the execution venue, spiked it, and dropped it. The findings are worth reporting because we could not find them documented anywhere.

### Aqua strategies are ABI-encoded SwapVM Orders

Not stated in the docs, and it is the key to discovering tradeable liquidity without an indexer:

- The `Shipped(address maker, address app, bytes32 strategyHash, bytes strategy)` event carries the full strategy bytes
- `keccak256(strategy) == strategyHash` ✓
- `abi.decode(strategy, (address, uint256, bytes))` yields a valid `ISwapVM.Order`, and the decoded `maker` matches the event's ✓
- `SwapVMRouter.hash(order)` returns **exactly** the Aqua `strategyHash` ✓

Verified against 7 live strategies on Base. So: read registry events, drop the `Docked` ones, decode. That is the whole discovery layer, and documenting it would remove a real barrier to takers joining.

### Reverts carry no return data

Every `quote()` we attempted reverted with no revert data — `{"code":3,"message":"execution reverted"}`, no selector, on Alchemy as well as four public RPCs. With 97 custom errors defined across the SwapVM and Aqua sources, a selector would have told us the answer instantly. Without one there is nothing to look up.

### There is no TypeScript path

This is what ended it for us. `ProgramBuilder`, `BalancesArgsBuilder` and the instruction builders are **Solidity libraries**, used from Solidity tests. The only TypeScript in the repo is the Hardhat config and Ignition deploy modules.

For a TypeScript agent, shipping a strategy means writing Solidity, compiling through Hardhat with `viaIR` at roughly seven minutes a cycle, and deploying with real funds — before you can take against it. That is a different project from the one we were building, and with four days left the `Venue` interface we had put execution behind meant dropping Aqua cost us one integration rather than the whole thing.

A TypeScript program builder — even limited to the "strict, predefined subset" the docs say production integrations will use — would open Aqua to the agent ecosystem it seems aimed at. The taker side is already reachable from TypeScript; it is composing a program that is not.

### What we did build

`buildTakerTraitsAndData` in `lib/exec/aqua.ts`: a TypeScript encoder for the `TakerTraitsLib` payload — 20 bytes of cumulative slice offsets packed high-to-low, a 2-byte flag word, then the slices, with the signature as the tail. 25 assertions cover it, including a case with every slice populated to catch offset drift, and the omission rules (`to` dropped when it equals the taker, `deadline` dropped when zero) that silently misread every later slice if you get them wrong.

It is MIT-licensed in this repo and 1inch is welcome to it.

---

## Privy

Wallet policies as the enforcement layer for an agent mandate. This worked, and was the strongest part of the build once we got past one thing.

### A catch-all DENY rule silently disables the whole policy

We added what we thought was a safety net:

```json
{ "name": "deny everything else", "method": "*", "action": "DENY", "conditions": [] }
```

Every transaction was then refused, including compliant ones. We bisected it: a minimal policy with one `to eq <router>` ALLOW rule passes; add the catch-all DENY and the same transaction is refused.

So a matching DENY overrides every ALLOW regardless of rule order — and since policies are already deny-by-default, the "safety net" only removes function. This cost us hours, and the failure is silent: `policy_violation` looks identical whether your conditions are wrong or your extra rule is eating them.

Worth an explicit line in the policy docs: *policies are allowlists; do not add a catch-all DENY.* A validation warning at policy-creation time would be better still.

### Constraining only `eth_sendTransaction` leaves a hole

Our first policy allowed `eth_sendTransaction` and nothing else. That still lets the agent call `eth_signTransaction` and broadcast the signed transaction through any RPC it likes — the policy is bypassed entirely.

We now emit rules for both methods. This is an easy hole to leave open, and the docs' examples all use `eth_sendTransaction`, which is exactly the shape that invites the mistake.

### Small things that cost 400s

- Rule names must be **under 50 characters**. `approve the mandated router only (eth_sendTransaction)` is 53. The error is clear once it arrives, but the limit is not in the reference
- `chain_id` conditions take a **string**; passing `8453` as a number is rejected with `Expected string, received number`
- Calldata fields must be `"functionName.argumentName"`. We tried `params.tokenOut` for a tuple parameter; the correct path is `exactInputSingle.params.tokenOut`. The error message here was genuinely excellent — it named the required format and pointed at the field
- `PrivyClientOptions` takes `appId`; the internal client type uses `appID`. Passing `appID` to `PrivyClient` type-errors but *works at runtime*, because the SDK falls back to `process.env.PRIVY_APP_ID`. That silent fallback sent us down a false trail debugging a dead app
- `wallets().list({ limit: 5 })` returns 500; `wallets().list()` works

### What made the product possible

`ethereum_calldata` conditions with an ABI are the reason this project exists. Being able to say "the decoded `tokenOut` must be in this allowlist, and `amountIn` must be at most this" means a mandate clause becomes an infrastructure guarantee rather than an application-level check. When a judge asks "what if the agent tries anyway", the answer is a refusal from the enclave, not a promise about our code.

Being able to swap a wallet's `policy_ids` at runtime is what makes human escalation work: the owner signs an EIP-712 override, reckon compiles a widened policy for that one action, attaches it, executes, and restores the base policy in a `finally`. The temporary widening is visible and auditable.

One request: a documented way to scope a policy change to a **single next transaction** would remove the swap-and-restore dance, and with it the window where a crash leaves a widened policy attached. We handle it with `finally`, but the primitive belongs in the platform.
