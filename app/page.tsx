import { RunPanel } from "./RunPanel";
import snapshot from "./receipts-snapshot.json";
import { isLive, readReceiptsFile } from "@/lib/receipts/store";
import { summarize } from "@/lib/receipts/types";
import type { Receipt } from "@/lib/receipts/types";

export const dynamic = "force-dynamic";

const usd = (n: number) =>
  `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 100 ? 2 : 0 })}`;

function verdictTone(receipt: Receipt) {
  if (receipt.verdict.kind === "allow") return "text-allow";
  if (receipt.verdict.kind === "deny") return "text-deny";
  return "text-escalate";
}

function verdictLabel(receipt: Receipt) {
  if (receipt.verdict.kind === "allow") return "allowed";
  if (receipt.verdict.kind === "deny") return "denied";
  return receipt.authorization.outcome === "granted" ? "escalated, approved" : "escalated";
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] gap-x-4 gap-y-1 py-1.5 border-t border-line first:border-t-0">
      <dt className="text-xs uppercase tracking-wider text-muted pt-0.5">{label}</dt>
      <dd className="text-sm leading-relaxed">{children}</dd>
    </div>
  );
}

function ReceiptCard({ receipt }: { receipt: Receipt }) {
  const { observation, proposal, verdict, authorization, execution } = receipt;
  const risk = observation.risk;

  return (
    <article className="rounded-lg border border-line bg-panel overflow-hidden">
      <header className="flex flex-wrap items-baseline justify-between gap-3 px-5 py-3.5 border-b border-line">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-xs text-muted">{receipt.id}</span>
          <h3 className="text-sm font-medium">{receipt.trigger}</h3>
        </div>
        <span className={`text-xs font-medium uppercase tracking-wider ${verdictTone(receipt)}`}>
          {verdictLabel(receipt)}
        </span>
      </header>

      <dl className="px-5 py-3">
        <Field label="proposed">
          {proposal.kind === "buy" ? "buy" : "sell"} {usd(proposal.amountUsd)} of{" "}
          <span className="font-medium">{proposal.symbol}</span> on {proposal.venue}
          <span className="block text-muted text-xs mt-0.5">{proposal.rationale}</span>
        </Field>

        <Field label="observed">
          {risk ? (
            <>
              <span className="font-mono text-xs">
                {risk.ageDays.toFixed(0)}d old · trough liquidity {usd(risk.sustainedLiquidityUsd)} ·{" "}
                {risk.holderConcentrationExContractsPct?.toFixed(2) ?? "?"}% held by wallets
              </span>
              <span className="block text-muted text-xs mt-0.5">
                via The Graph, {observation.poolsSeen} Uniswap pools
                {risk.contractsInTopHolders > 0 &&
                  ` · ${risk.contractsInTopHolders} of the top 10 holders are contracts`}
              </span>
            </>
          ) : (
            <span className="text-muted">no historical data needed</span>
          )}
        </Field>

        <Field label="clauses">
          {verdict.kind === "allow" ? (
            <span className="text-allow">every clause cleared</span>
          ) : (
            <ul className="space-y-1">
              {verdict.violations.map((v, i) => (
                <li key={i}>
                  <span className={`font-mono text-xs ${v.severity === "hard" ? "text-deny" : "text-escalate"}`}>
                    {v.clause}
                  </span>{" "}
                  <span className="text-xs text-muted">[{v.severity}]</span>
                  <span className="block text-xs mt-0.5">{v.explain}</span>
                  <span className="block text-xs text-muted font-mono">
                    observed {v.observed} · allowed {v.limit}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Field>

        <Field label="authorised by">
          <span className="font-mono text-xs">{authorization.layer}</span>{" "}
          <span className="text-xs text-muted">→ {authorization.outcome}</span>
          <span className="block text-xs mt-0.5">{authorization.detail}</span>
        </Field>

        {execution && (
          <Field label="executed">
            <span className="font-mono text-xs break-all">{execution.txHash}</span>
            <span className="block text-muted text-xs mt-0.5">
              Uniswap v3, fee {execution.feeTier / 10000}%
            </span>
          </Field>
        )}

        <Field label="mandate">
          <span className="font-mono text-xs break-all text-muted">{receipt.mandateHash}</span>
        </Field>
      </dl>
    </article>
  );
}

export default async function Page({ searchParams }: PageProps<"/">) {
  const params = await searchParams;
  const supplied = typeof params.key === "string" ? params.key : "";
  const canRun = Boolean(process.env.RECKON_DEMO_KEY) && supplied === process.env.RECKON_DEMO_KEY;

  const live = isLive();
  const receipts = (live ? readReceiptsFile() : (snapshot as unknown as Receipt[]))
    .slice()
    .reverse();

  const executed = receipts.filter((r: Receipt) => r.execution).length;
  const denied = receipts.filter((r: Receipt) => r.verdict.kind === "deny").length;
  const escalated = receipts.filter((r: Receipt) => r.verdict.kind === "escalate").length;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-14">
      <header className="mb-10">
        <h1 className="text-2xl font-semibold tracking-tight">reckon</h1>
        <p className="mt-1.5 text-sm text-muted max-w-lg">
          An agent that manages a treasury under a signed mandate it cannot forge. Every
          decision leaves a receipt: what it saw, what it wanted to do, and who let it.
        </p>
      </header>

      {canRun && <RunPanel demoKey={supplied} />}

      <section className="mb-10 grid grid-cols-3 gap-px bg-line border border-line rounded-lg overflow-hidden">
        {[
          { label: "executed", value: executed, tone: "text-allow" },
          { label: "denied", value: denied, tone: "text-deny" },
          { label: "escalated", value: escalated, tone: "text-escalate" },
        ].map((s) => (
          <div key={s.label} className="bg-panel px-5 py-4">
            <div className={`text-2xl font-semibold tabular-nums ${s.tone}`}>{s.value}</div>
            <div className="text-xs uppercase tracking-wider text-muted mt-0.5">{s.label}</div>
          </div>
        ))}
      </section>

      <section className="space-y-4">
        <h2 className="text-xs uppercase tracking-wider text-muted">receipts</h2>
        {receipts.length === 0 ? (
          <p className="text-sm text-muted border border-line rounded-lg px-5 py-8 text-center">
            No receipts yet. Run <code className="font-mono">npm run run:cycle</code>.
          </p>
        ) : (
          receipts.map((r: Receipt) => <ReceiptCard key={r.id} receipt={r} />)
        )}
      </section>

      <footer className="mt-12 pt-6 border-t border-line text-xs text-muted">
        {!live && (
          <p className="mb-2">
            A recorded run against a fork of Base mainnet — real pools, real prices, real
            signatures, fake funds. Reproduce it with{" "}
            <code className="font-mono">npm run run:cycle</code>.
          </p>
        )}
        {receipts.length > 0 && <p>{summarize(receipts[0])}</p>}
        <p className="mt-1">Historical data via The Graph · execution on Uniswap v3 · signing under a Privy policy</p>
      </footer>
    </main>
  );
}
