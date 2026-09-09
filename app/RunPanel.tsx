"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const SCENARIOS = [
  { id: "rebalance", label: "Rebalance $5 WETH", hint: "inside every clause" },
  { id: "memecoin", label: "Buy $5 DEGEN", hint: "fails §4 on liquidity" },
  { id: "oversized", label: "Buy $12 WETH", hint: "breaches §2, escalates" },
  { id: "authorised", label: "…with the owner's signature", hint: "override, then executes" },
] as const;

export function RunPanel({ demoKey }: { demoKey: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ summary: string; txHash?: string } | null>(null);

  async function run(scenario: string) {
    setBusy(scenario);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/cycle", {
        method: "POST",
        headers: { "content-type": "application/json", "x-demo-key": demoKey },
        body: JSON.stringify({ scenario }),
      });
      const body = (await res.json()) as {
        error?: string;
        summary?: string;
        receipt?: { execution?: { txHash?: string } };
      };
      if (!res.ok) {
        setError(body.error ?? `failed with ${res.status}`);
      } else {
        setResult({ summary: body.summary ?? "done", txHash: body.receipt?.execution?.txHash });
        router.refresh();
      }
    } catch (e) {
      setError(String((e as Error).message).slice(0, 140));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mb-10 rounded-lg border border-line bg-panel px-5 py-4">
      <h2 className="text-xs uppercase tracking-wider text-muted">run a decision</h2>
      <p className="mt-1 text-xs text-muted">
        Against a fork of Base mainnet — real pools and prices, fake funds. Privy signs every
        transaction, so the policy is genuinely enforced.
      </p>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.id}
            onClick={() => run(s.id)}
            disabled={busy !== null}
            className="text-left rounded border border-line px-3 py-2 hover:bg-background disabled:opacity-50 transition-colors"
          >
            <span className="block text-sm">{busy === s.id ? "running…" : s.label}</span>
            <span className="block text-xs text-muted">{s.hint}</span>
          </button>
        ))}
      </div>

      {error && <p className="mt-3 text-xs text-deny">{error}</p>}

      {result && (
        <div className="mt-3 rounded border border-line px-3 py-2">
          <p className="text-sm">{result.summary}</p>
          {result.txHash && (
            <p className="text-xs text-muted font-mono break-all mt-0.5">{result.txHash}</p>
          )}
        </div>
      )}
    </section>
  );
}
