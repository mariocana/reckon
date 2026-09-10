import type { Address } from "viem";
import { TOKENS, TRACKED, demoMandate, forkClient } from "@/lib/agent/demo";
import { planAction, PlannerError, type Candidate } from "@/lib/agent/plan";
import { readPortfolio, formatPortfolio } from "@/lib/data/portfolio";
import { getTokenRisk } from "@/lib/data/risk";
import { describeVerdict, evaluate } from "@/lib/mandate/evaluate";
import type { TokenRisk } from "@/lib/types";

const client = forkClient();
const agent = process.env.PRIVY_WALLET_ADDRESS! as Address;
const mandate = demoMandate(agent);

const portfolio = await readPortfolio(client, agent, TRACKED, TOKENS.USDC);
console.log(`treasury`);
console.log(formatPortfolio(portfolio));

const wanted: Array<{ symbol: string; token: Address; note?: string }> = [
  { symbol: "WETH", token: TOKENS.WETH },
  { symbol: "cbBTC", token: TOKENS.cbBTC },
  { symbol: "DEGEN", token: TOKENS.DEGEN },
];

const candidates: Candidate[] = [];
const riskBySymbol = new Map<string, TokenRisk>();

for (const w of wanted) {
  try {
    const { risk } = await getTokenRisk(w.token);
    riskBySymbol.set(w.symbol, risk);
    candidates.push({ symbol: w.symbol, token: w.token, risk, note: w.note });
  } catch {
    candidates.push({ symbol: w.symbol, token: w.token, risk: null, note: w.note });
  }
}

console.log(`\nasking the model, with §4 facts for ${riskBySymbol.size} of ${wanted.length} candidates`);

let result;
try {
  result = await planAction({
    mandate,
    portfolio,
    candidates,
    venue: "uniswap",
    signals: ["DEGEN is trending across Base social feeds today."],
  });
} catch (error) {
  if (error instanceof PlannerError) {
    console.error(`\n${error.message}`);
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(`\nAdd a key: echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env`);
    }
    process.exit(1);
  }
  throw error;
}

const { plan, proposal, model } = result;

console.log(`\n${model} proposes`);
console.log(`  ${plan.action === "none" ? "no action" : `${plan.action} $${plan.amountUsd} ${plan.symbol}`}  (confidence: ${plan.confidence})`);
console.log(`  ${plan.rationale}`);

if (!proposal) {
  console.log(`\nnothing to evaluate.`);
  process.exit(0);
}

const verdict = evaluate(mandate, proposal, {
  portfolio,
  risk: riskBySymbol.get(proposal.symbol),
  stables: [TOKENS.USDC],
  now: new Date(),
});

console.log(`\nthe mandate says`);
console.log(`  → ${describeVerdict(verdict)}`);

if (verdict.kind !== "allow") {
  for (const v of verdict.violations) {
    console.log(`     ${v.clause} [${v.severity}] ${v.explain}`);
    console.log(`        observed ${v.observed}, allowed ${v.limit}`);
  }
}
