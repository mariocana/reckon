import type { Address } from "viem";
import {
  SCENARIOS,
  TOKENS,
  TRACKED,
  buildDemoOverride,
  demoMandate,
  forkClient,
  runScenario,
  type ScenarioId,
} from "@/lib/agent/demo";
import { formatPortfolio, readPortfolio } from "@/lib/data/portfolio";
import { describeTerms } from "@/lib/mandate/schema";
import { describeOverride } from "@/lib/mandate/override";
import { summarize, type Receipt } from "@/lib/receipts/types";

const client = forkClient();
const agent = process.env.PRIVY_WALLET_ADDRESS! as Address;
const mandate = demoMandate(agent);

const order: ScenarioId[] = ["rebalance", "memecoin", "oversized", "authorised"];

console.log(describeTerms(mandate));
console.log(`\nportfolio`);
console.log(formatPortfolio(await readPortfolio(client, agent, TRACKED, TOKENS.USDC)));

function report(receipt: Receipt) {
  console.log(`  ${summarize(receipt)}`);

  const risk = receipt.observation.risk;
  if (risk) {
    const liq = (risk.sustainedLiquidityUsd / 1e6).toFixed(1);
    const wallets = risk.holderConcentrationExContractsPct?.toFixed(2) ?? "?";
    console.log(
      `  observed   ${risk.ageDays.toFixed(0)}d old, trough liq $${liq}M, wallets ${wallets}%  ` +
        `(${receipt.observation.poolsSeen} pools)`
    );
  }

  if (receipt.verdict.kind !== "allow") {
    for (const v of receipt.verdict.violations) {
      console.log(`  ${v.clause} [${v.severity}] ${v.explain}`);
    }
  }

  const a = receipt.authorization;
  console.log(`  authorised ${a.layer} → ${a.outcome}: ${a.detail}`);
  if (receipt.execution) console.log(`  executed   ${receipt.execution.txHash}`);
  console.log(`  receipt    ${receipt.id}  mandate ${receipt.mandateHash.slice(0, 14)}…`);
}

for (const id of order) {
  console.log(`\n${"─".repeat(74)}`);
  console.log(SCENARIOS[id].trigger);

  let signed;
  if (id === "authorised") {
    signed = await buildDemoOverride(mandate, SCENARIOS[id].action);
    console.log(
      describeOverride(signed.override)
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")
    );
    console.log();
  }

  report(await runScenario(id, signed));
}

console.log(`\nfinal portfolio`);
console.log(formatPortfolio(await readPortfolio(client, agent, TRACKED, TOKENS.USDC)));
