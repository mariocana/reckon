# reckon

An agent that manages a treasury under a **mandate signed by the owner that the agent cannot forge**.

The interesting moment is not the agent trading. It is the agent being *refused*.

```
weekly rebalance: WETH is underweight        → executed        privy-policy granted
flagged by the community                     → denied §4       trough liquidity $493K < $2M
realignment past the concentration ceiling   → escalated §2    the owner has to decide
  ↓ owner signs an override
same action, with the owner's signature      → executed        policy widened, then restored
```

## The problem

Delegating capital to an agent means trusting it not to do something stupid at 3am. Today that trust rests on the agent's own code — an `if` statement it could be argued out of, a prompt it could be talked around.

reckon replaces that with a document. The owner writes a mandate in plain terms, signs it, and the agent holds a copy it cannot alter. Every clause is then enforced in three independent places.

## Three layers of enforcement

| layer | who decides | what it catches |
|---|---|---|
| **Mandate evaluator** | the clauses, evaluated against live data | portfolio-wide limits: reserve floor, concentration ceiling, cadence, investable universe |
| **Privy wallet policy** | the signing enclave | per-transaction limits, compiled from the same mandate — the agent physically cannot sign outside them |
| **Owner override** | an EIP-712 signature from the owner | one action, one nonce, one expiry, bound to the mandate hash |

The layers are deliberately redundant. The evaluator can be wrong; the policy still holds. Both can agree; the owner can still refuse to sign.

## The mandate

Six clauses, validated with zod and hashed into an EIP-712 document:

```
§1 Keep at least 60% of the treasury in stablecoins.
§2 Hold no more than 15% in any single asset.
§3 Trade no more than $500 at a time.
§4 Only tokens at least 90 days old, with at least $2,000,000 of sustained
   liquidity, and no more than 40% held by the wallets among the top 10
   holders, contracts excluded.
§5 Leave at least 3600s between trades.
§6 Execute only on: uniswap.
```

What the owner signs is this text *plus* a hash binding the exact clause values. Change a single number and the hash changes; every receipt cites the hash in force when the agent acted.

**Hard vs soft.** §4, §5 and §6 are hard — nobody waives them in flight; the owner has to issue a new mandate. §1, §2 and §3 are soft — bounds the owner can knowingly exceed for one action, which is what escalates.

## Where the data comes from

§4 asks *historical* questions that a price feed cannot answer. Two Graph products, composed:

| §4 check | source |
|---|---|
| token age | Uniswap v3 subgraph — `createdAtTimestamp` of the oldest pool |
| sustained liquidity | Uniswap v3 subgraph — the **trough** of `poolDayDatas.tvlUSD` over 30 days, not the spot figure |
| holder concentration | Token API — top 10 holders against circulating supply |

Two findings that changed the design:

**A trough, not an average.** A pool that dipped to $40k for one day is not liquid, however healthy it looks today. Averaging hides exactly the risk the clause exists to catch.

**Contracts are not holders.** The top 10 WETH holders on Base control 52% of supply — but 9 of the 10 are bridges and protocol contracts, and real wallets hold 0.93%. The naive metric rejects WETH for the wrong reason. §4 counts wallets; the receipt records both numbers.

## Execution

Uniswap v3 on Base, through `SwapRouter02`.

The subgraph proposes a fee tier, ranked by TVL. It is not trusted with the price: reckon quotes **all four tiers in parallel** through QuoterV2 and takes the best fill. On WETH/USDC the highest-TVL pool (0.3%) loses to the 0.01% pool by ~0.6%, and the winner flips to 0.05% around $5,000. The subgraph narrows the search and leaves an audit trail; the quoter decides.

### Where the Uniswap integration lives

| what | where | contract on Base |
|---|---|---|
| addresses | [`lib/exec/uniswap.ts:14-18`](lib/exec/uniswap.ts#L14-L18) | SwapRouter02 `0x2626664c2603336E57B271c5C0b26F421741e481`<br>QuoterV2 `0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a`<br>V3Factory `0x33128a8fC17869897dcE68Ed026d694621f6FDfD` |
| quote one fee tier | [`lib/exec/uniswap.ts:58`](lib/exec/uniswap.ts#L58) `quoteAtFee` | `QuoterV2.quoteExactInputSingle`, called through `simulateContract` because it reverts internally |
| quote all tiers, take the best | [`lib/exec/uniswap.ts:76`](lib/exec/uniswap.ts#L76) `quote` | the 0.6% improvement above comes from here |
| execute the swap | [`lib/exec/uniswap.ts:137`](lib/exec/uniswap.ts#L137) `execute` | `SwapRouter02.exactInputSingle`, with the ERC-20 approval when the allowance is short |
| pools for one token | [`lib/data/graph.ts:201`](lib/data/graph.ts#L201) `POOLS_QUERY` | v3 subgraph — token age from the oldest `createdAtTimestamp` |
| daily TVL series | [`lib/data/graph.ts:269`](lib/data/graph.ts#L269) `POOL_DAYS_QUERY` | v3 subgraph — `poolDayDatas`, whose trough answers §4 |
| best pool for a pair | [`lib/data/graph.ts:337`](lib/data/graph.ts#L337) `getBestPoolForPair` | v3 subgraph — ranks fee tiers before quoting |
| subgraph deployment | [`lib/data/graph.ts:18-19`](lib/data/graph.ts#L18-L19) | `HMuAwufqZ1YCRmzL2SfHTVkzZovC9VL2UAKhjvRqKiR1`, override with `UNISWAP_V3_BASE_SUBGRAPH_ID` |

Reproduce the quote comparison with `npm run demo:quote`. Findings from the integration are in
[FEEDBACK.md](FEEDBACK.md).

## Receipts

Every decision appends one line to `data/receipts.jsonl`:

```
observation    what it saw — age, trough liquidity, holders, pool count, from The Graph
proposal       what it wanted to do, and why
verdict        which clauses cleared or broke, with observed values and limits
authorization  who let it — privy-policy, human-escalation, or nobody
execution      what it did — tx hash, fee tier, amounts
mandateHash    which rules were in force at that moment
```

The dashboard renders them in reverse order. That is the whole UI: no charts, no dials — a ledger of what the agent saw, wanted, was permitted, and did.

## Running it

```bash
npm install
cp .env.example .env    # then fill it in
npm run dev             # dashboard on :3000
```

Nothing here needs real money. Everything runs against a fork of Base mainnet, which keeps the real
Uniswap pools and real prices while the funds are fake:

```bash
npm run fork:fund     # 50 USDC + 1 ETH onto the agent wallet, non-stables reset to zero
npm run run:cycle     # four decisions, four receipts
```

`FORK_RPC_URL` decides where that fork lives. A **Tenderly Virtual TestNet** forking Base is the
one worth using — it stays up without your laptop, and `tenderly_setErc20Balance` writes balances
straight to storage, so funding needs no whale impersonation. Create it with **chain id 8453**, so
the wallet policy is byte-identical to one guarding a real mainnet wallet, and never fund that
agent wallet on real Base.

A local `anvil --fork-url $BASE_RPC_URL --port 8545` also works; `fork:fund` detects which it is
talking to and funds accordingly.

Privy still signs every transaction, so the policy is genuinely exercised — reckon signs through Privy and broadcasts through its own RPC, which is why the fork works and why the policy is enforced regardless of which RPC is in use.

| script | what it does |
|---|---|
| `npm run run:cycle` | the full loop: observe, evaluate, authorise, execute, record |
| `npm run demo:risk [token]` | §4 inputs for a token, straight from The Graph |
| `npm run demo:quote` | Uniswap quotes across all fee tiers |
| `npm run demo:policy` | the Privy policy JSON compiled from the mandate |
| `npm run demo:evaluate` | the evaluator against fixtures — allow, deny, escalate |
| `npm run privy:setup` | creates the agent wallet and installs the mandate policy |
| `npm run test:aqua-encoding` | 25 assertions over the SwapVM taker encoder |

## Deploying

The dashboard runs anywhere Next.js does. It needs a persistent disk if you want receipts to
accumulate, because they are appended to a JSONL file rather than a database — the file *is* the
ledger, and keeping it as one plain append-only file is deliberate.

On Railway, attach a volume and point both state paths at it:

```
RECKON_RECEIPTS_FILE=/data/receipts.jsonl
RECKON_RISK_CACHE=/data/risk-cache.json
```

Without a volume the app still works: the dashboard falls back to a committed snapshot of a
recorded run, and the run panel reports each result inline rather than relying on persistence.

`FORK_RPC_URL` should point at a hosted fork — a Tenderly Virtual TestNet forking Base with chain
id 8453 keeps the wallet policy byte-identical to the one that would guard a real mainnet wallet.
**Never set `FORK_ADMIN_RPC_URL` on a deployed instance**: the admin RPC can rewrite balances and
storage, and nothing the app serves needs it.

Set `RECKON_DEMO_KEY` to expose the run panel at `/?key=<value>`. Leave it unset and the dashboard
is read-only, with `/api/cycle` refusing every request.

## Environment

```
BASE_RPC_URL           Base mainnet RPC (Alchemy free tier is enough)
GRAPH_API_KEY          The Graph gateway, for the Uniswap subgraph
GRAPH_TOKEN_API_KEY    Token API JWT — a separate credential, starts with eyJ
PRIVY_APP_ID           from dashboard.privy.io
PRIVY_APP_SECRET
PRIVY_WALLET_ID        written by npm run privy:setup
PRIVY_WALLET_ADDRESS
PRIVY_POLICY_ID

FORK_RPC_URL           where the fork lives — Tenderly public RPC, or local anvil
FORK_ADMIN_RPC_URL     admin RPC, used only by fork:fund. Never set this in production
RECKON_DEMO_KEY        unset means read-only; set it to expose the run panel
RECKON_RECEIPTS_FILE   defaults to data/receipts.jsonl
RECKON_RISK_CACHE      defaults to data/risk-cache.json
```

The gateway key and the Token API JWT are **different credentials**. A Graph Studio key returns 401 against the Token API.

## Layout

```
lib/mandate/    schema, hashing, EIP-712, the clause evaluator, owner overrides
lib/data/       The Graph client, §4 risk assembly, portfolio reader
lib/exec/       Venue interface, Uniswap v3, Privy policy compiler and signer
lib/receipts/   receipt shape and append-only store
lib/agent/      the cycle that ties them together
app/            the receipts dashboard
```

Execution sits behind a `Venue` interface on purpose. 1inch Aqua was the original venue and was dropped after a spike — SwapVM programs are composed only from Solidity builders, with no TypeScript path. The interface meant that cost one integration rather than the project. See [FEEDBACK.md](FEEDBACK.md).

## Licence

MIT
