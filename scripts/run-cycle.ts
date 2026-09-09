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
console.log(`\nportafoglio`);
console.log(formatPortfolio(await readPortfolio(client, agent, TRACKED, TOKENS.USDC)));

function report(receipt: Receipt) {
  console.log(`  ${summarize(receipt)}`);

  const risk = receipt.observation.risk;
  if (risk) {
    const liq = (risk.sustainedLiquidityUsd / 1e6).toFixed(1);
    const wallets = risk.holderConcentrationExContractsPct?.toFixed(2) ?? "?";
    console.log(
      `  visto      ${risk.ageDays.toFixed(0)}g, liquidità min $${liq}M, wallet ${wallets}%  ` +
        `(${receipt.observation.poolsSeen} pool)`
    );
  }

  if (receipt.verdict.kind !== "allow") {
    for (const v of receipt.verdict.violations) {
      console.log(`  ${v.clause} [${v.severity}] ${v.explain}`);
    }
  }

  const a = receipt.authorization;
  console.log(`  autorizza  ${a.layer} → ${a.outcome}: ${a.detail}`);
  if (receipt.execution) console.log(`  eseguito   ${receipt.execution.txHash}`);
  console.log(`  ricevuta   ${receipt.id}  mandato ${receipt.mandateHash.slice(0, 14)}…`);
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

console.log(`\nportafoglio finale`);
console.log(formatPortfolio(await readPortfolio(client, agent, TRACKED, TOKENS.USDC)));
