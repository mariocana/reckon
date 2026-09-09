import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Receipt } from "./types";

const RECEIPTS_FILE = process.env.RECKON_RECEIPTS_FILE ?? "data/receipts.jsonl";

function replacer(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

export function appendReceipt(receipt: Receipt, file = RECEIPTS_FILE): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(file, JSON.stringify(receipt, replacer) + "\n");
}

export function readReceiptsFile(file = RECEIPTS_FILE): Receipt[] {
  if (!existsSync(file)) return [];

  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Receipt];
      } catch {
        return [];
      }
    });
}

export function nextReceiptId(file = RECEIPTS_FILE): string {
  return `rcpt_${String(readReceiptsFile(file).length + 1).padStart(4, "0")}`;
}

export function isLive(file = RECEIPTS_FILE): boolean {
  return existsSync(file) && readReceiptsFile(file).length > 0;
}
