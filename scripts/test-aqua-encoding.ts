import { size, slice as sliceHex, type Address, type Hex } from "viem";
import { buildTakerTraitsAndData, decodeTakerTraitsAndData } from "@/lib/exec/aqua";

const TAKER = "0x1111111111111111111111111111111111111111" as Address;
const OTHER = "0x2222222222222222222222222222222222222222" as Address;

let failures = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const a = typeof actual === "bigint" ? actual.toString() : JSON.stringify(actual);
  const e = typeof expected === "bigint" ? expected.toString() : JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok   ${label}`);
  } else {
    console.log(`  FAIL ${label}\n         got      ${a}\n         expected ${e}`);
    failures++;
  }
}

console.log("minimal payload — no threshold, no recipient, no deadline");
{
  const packed = buildTakerTraitsAndData({ taker: TAKER, isExactIn: true, isAToB: true });
  const d = decodeTakerTraitsAndData(packed);

  check("header is 22 bytes", size(sliceHex(packed, 0, 22)), 22);
  check("body is empty", size(packed) - 22, 0);
  check("isExactIn", d.isExactIn, true);
  check("isAToB", d.isAToB, true);
  check("flags", d.flags, 0x0001 | 0x0080);
}

console.log("\nthreshold, deadline and a distinct recipient");
{
  const deadline = 1_800_000_000;
  const packed = buildTakerTraitsAndData({
    taker: TAKER,
    isExactIn: true,
    isAToB: false,
    threshold: 123_456_789n,
    to: OTHER,
    deadline,
    allowPartialFill: true,
  });
  const d = decodeTakerTraitsAndData(packed);

  check("threshold is 32 bytes", size(d.threshold), 32);
  check("threshold round-trips", BigInt(d.threshold), 123_456_789n);
  check("recipient is 20 bytes", size(d.to), 20);
  check("recipient round-trips", (d.to as string).toLowerCase(), OTHER.toLowerCase());
  check("deadline is 5 bytes", size(d.deadline), 5);
  check("deadline round-trips", Number(BigInt(d.deadline)), deadline);
  check("allowPartialFill", d.allowPartialFill, true);
  check("isAToB off", d.isAToB, false);
}

console.log("\nrecipient equal to taker is omitted, matching the contract");
{
  const packed = buildTakerTraitsAndData({ taker: TAKER, isExactIn: true, isAToB: true, to: TAKER });
  check("no recipient bytes", size(decodeTakerTraitsAndData(packed).to), 0);
}

console.log("\nzero deadline is omitted");
{
  const packed = buildTakerTraitsAndData({ taker: TAKER, isExactIn: true, isAToB: true, deadline: 0 });
  check("no deadline bytes", size(decodeTakerTraitsAndData(packed).deadline), 0);
}

console.log("\nevery slice populated, to catch offset drift");
{
  const hexOf = (byte: number, len: number): Hex =>
    `0x${byte.toString(16).padStart(2, "0").repeat(len)}` as Hex;

  const args = {
    taker: TAKER,
    isExactIn: false,
    isAToB: true,
    threshold: 42n,
    to: OTHER,
    deadline: 1_700_000_000,
    hasPreTransferInCallback: true,
    hasPreTransferOutCallback: true,
    preTransferInHookData: hexOf(0xa1, 3),
    postTransferInHookData: hexOf(0xa2, 5),
    preTransferOutHookData: hexOf(0xa3, 7),
    postTransferOutHookData: hexOf(0xa4, 11),
    preTransferInCallbackData: hexOf(0xa5, 13),
    preTransferOutCallbackData: hexOf(0xa6, 17),
    instructionsArgs: hexOf(0xa7, 19),
    signature: hexOf(0xa8, 65),
  } as const;

  const d = decodeTakerTraitsAndData(buildTakerTraitsAndData(args));

  check("preTransferInHookData", d.preTransferInHookData, args.preTransferInHookData);
  check("postTransferInHookData", d.postTransferInHookData, args.postTransferInHookData);
  check("preTransferOutHookData", d.preTransferOutHookData, args.preTransferOutHookData);
  check("postTransferOutHookData", d.postTransferOutHookData, args.postTransferOutHookData);
  check("preTransferInCallbackData", d.preTransferInCallbackData, args.preTransferInCallbackData);
  check("preTransferOutCallbackData", d.preTransferOutCallbackData, args.preTransferOutCallbackData);
  check("instructionsArgs", d.instructionsArgs, args.instructionsArgs);
  check("signature is the tail", d.signature, args.signature);
  check("isExactIn off", d.isExactIn, false);
}

console.log("\ncallback data without its flag is rejected");
{
  try {
    buildTakerTraitsAndData({
      taker: TAKER,
      isExactIn: true,
      isAToB: true,
      preTransferInCallbackData: "0xdeadbeef",
    });
    check("throws", "no error", "VenueError");
  } catch (e) {
    check("throws", (e as Error).name, "VenueError");
  }
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
