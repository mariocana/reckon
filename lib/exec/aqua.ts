import {
  concatHex,
  createPublicClient,
  http,
  numberToHex,
  size,
  slice as sliceHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { base } from "viem/chains";
import { VenueError, type Signer, type SwapQuote, type SwapRequest, type Venue } from "./venue";

export const AQUA_ADDRESSES = {
  swapVmRouter: "0x111111338c5091E8440b67B168bAe16a668AC0De",
  registry: "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
} as const satisfies Record<string, Address>;

export interface Order {
  maker: Address;
  traits: bigint;
  data: Hex;
}

export const SWAP_VM_ABI = [
  {
    type: "function",
    name: "quote",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "swap",
    stateMutability: "payable",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
      { name: "amount", type: "uint256" },
      { name: "takerTraitsAndData", type: "bytes" },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "amountOut", type: "uint256" },
      { name: "orderHash", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "hash",
    stateMutability: "view",
    inputs: [
      {
        name: "order",
        type: "tuple",
        components: [
          { name: "maker", type: "address" },
          { name: "traits", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
] as const;

const FLAG = {
  isExactIn: 0x0001,
  shouldUnwrapWeth: 0x0002,
  hasPreTransferInCallback: 0x0004,
  hasPreTransferOutCallback: 0x0008,
  isStrictThresholdAmount: 0x0010,
  isFirstTransferFromTaker: 0x0020,
  useTransferFromAndAquaPush: 0x0040,
  isAToB: 0x0080,
  allowPartialFill: 0x0100,
} as const;

export interface TakerTraitsArgs {
  taker: Address;
  isExactIn: boolean;
  isAToB: boolean;
  threshold?: bigint;
  isStrictThresholdAmount?: boolean;
  allowPartialFill?: boolean;
  shouldUnwrapWeth?: boolean;
  isFirstTransferFromTaker?: boolean;
  useTransferFromAndAquaPush?: boolean;
  to?: Address;
  deadline?: number;
  hasPreTransferInCallback?: boolean;
  hasPreTransferOutCallback?: boolean;
  preTransferInHookData?: Hex;
  postTransferInHookData?: Hex;
  preTransferOutHookData?: Hex;
  postTransferOutHookData?: Hex;
  preTransferInCallbackData?: Hex;
  preTransferOutCallbackData?: Hex;
  instructionsArgs?: Hex;
  signature?: Hex;
}

const EMPTY = "0x" as const;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_DEADLINE = 2 ** 40 - 1;

export function buildTakerTraitsAndData(args: TakerTraitsArgs): Hex {
  const threshold: Hex = args.threshold === undefined ? EMPTY : numberToHex(args.threshold, { size: 32 });

  const includeTo =
    args.to !== undefined &&
    args.to !== ZERO_ADDRESS &&
    args.to.toLowerCase() !== args.taker.toLowerCase();
  const to: Hex = includeTo ? (args.to as Hex) : EMPTY;

  if (args.deadline !== undefined && (args.deadline < 0 || args.deadline > MAX_DEADLINE)) {
    throw new VenueError("1inch-aqua", `deadline ${args.deadline} does not fit in uint40`);
  }
  const deadline: Hex = args.deadline ? numberToHex(args.deadline, { size: 5 }) : EMPTY;

  const preTransferInHookData = args.preTransferInHookData ?? EMPTY;
  const postTransferInHookData = args.postTransferInHookData ?? EMPTY;
  const preTransferOutHookData = args.preTransferOutHookData ?? EMPTY;
  const postTransferOutHookData = args.postTransferOutHookData ?? EMPTY;
  const preTransferInCallbackData = args.preTransferInCallbackData ?? EMPTY;
  const preTransferOutCallbackData = args.preTransferOutCallbackData ?? EMPTY;
  const instructionsArgs = args.instructionsArgs ?? EMPTY;
  const signature = args.signature ?? EMPTY;

  if (size(preTransferInCallbackData) > 0 && !args.hasPreTransferInCallback) {
    throw new VenueError("1inch-aqua", "preTransferInCallbackData set without hasPreTransferInCallback");
  }
  if (size(preTransferOutCallbackData) > 0 && !args.hasPreTransferOutCallback) {
    throw new VenueError("1inch-aqua", "preTransferOutCallbackData set without hasPreTransferOutCallback");
  }

  const payloads = [
    threshold,
    to,
    deadline,
    preTransferInHookData,
    postTransferInHookData,
    preTransferOutHookData,
    postTransferOutHookData,
    preTransferInCallbackData,
    preTransferOutCallbackData,
    instructionsArgs,
  ];

  const offsets: number[] = [];
  let running = 0;
  for (const p of payloads) {
    running += size(p);
    offsets.push(running);
  }

  if (running > 0xffff) {
    throw new VenueError("1inch-aqua", `taker data is ${running} bytes, past the uint16 offset limit`);
  }

  const offsetWords = concatHex(
    [...offsets].reverse().map((o) => numberToHex(o, { size: 2 }))
  );

  const flags =
    (args.isExactIn ? FLAG.isExactIn : 0) |
    (args.shouldUnwrapWeth ? FLAG.shouldUnwrapWeth : 0) |
    (args.isStrictThresholdAmount ? FLAG.isStrictThresholdAmount : 0) |
    (args.isFirstTransferFromTaker ? FLAG.isFirstTransferFromTaker : 0) |
    (args.useTransferFromAndAquaPush ? FLAG.useTransferFromAndAquaPush : 0) |
    (args.hasPreTransferInCallback ? FLAG.hasPreTransferInCallback : 0) |
    (args.hasPreTransferOutCallback ? FLAG.hasPreTransferOutCallback : 0) |
    (args.isAToB ? FLAG.isAToB : 0) |
    (args.allowPartialFill ? FLAG.allowPartialFill : 0);

  return concatHex([offsetWords, numberToHex(flags, { size: 2 }), ...payloads, signature]);
}

function emptySafeSlice(data: Hex, start: number, end: number): Hex {
  if (end <= start || start >= size(data)) return EMPTY;
  return sliceHex(data, start, Math.min(end, size(data)));
}

export function decodeTakerTraitsAndData(packed: Hex) {
  const header = sliceHex(packed, 0, 22);
  const body: Hex = size(packed) > 22 ? sliceHex(packed, 22) : EMPTY;

  const offsets: number[] = [];
  for (let i = 0; i < 10; i++) {
    const at = 18 - i * 2;
    offsets.push(Number(BigInt(sliceHex(header, at, at + 2))));
  }

  const flags = Number(BigInt(sliceHex(header, 20, 22)));
  const bodyLength = size(body);
  const bounds = [0, ...offsets];
  const slices = bounds.slice(0, -1).map((start, i) => emptySafeSlice(body, start, bounds[i + 1]));

  return {
    flags,
    threshold: slices[0],
    to: slices[1],
    deadline: slices[2],
    preTransferInHookData: slices[3],
    postTransferInHookData: slices[4],
    preTransferOutHookData: slices[5],
    postTransferOutHookData: slices[6],
    preTransferInCallbackData: slices[7],
    preTransferOutCallbackData: slices[8],
    instructionsArgs: slices[9],
    signature: emptySafeSlice(body, offsets[9], bodyLength),
    isExactIn: (flags & FLAG.isExactIn) !== 0,
    isAToB: (flags & FLAG.isAToB) !== 0,
    allowPartialFill: (flags & FLAG.allowPartialFill) !== 0,
  };
}

export interface AquaSwapRequest extends SwapRequest {
  order: Order;
  isAToB: boolean;
}

export class AquaVenue implements Venue {
  readonly id = "1inch-aqua" as const;

  constructor(private readonly client: PublicClient = defaultClient()) {}

  async quote(request: SwapRequest): Promise<SwapQuote> {
    const req = request as AquaSwapRequest;
    if (!req.order) {
      throw new VenueError("1inch-aqua", "no maker order to price against");
    }

    const takerData = buildTakerTraitsAndData({
      taker: req.taker,
      isExactIn: true,
      isAToB: req.isAToB,
      threshold: 0n,
    });

    const [amountIn, amountOut] = await this.client.readContract({
      address: AQUA_ADDRESSES.swapVmRouter,
      abi: SWAP_VM_ABI,
      functionName: "quote",
      args: [req.order, req.sellAmount, takerData],
    });

    const withSlippage = (amountOut * BigInt(10_000 - req.slippageBps)) / 10_000n;

    return {
      venue: this.id,
      request: req,
      buyAmount: amountOut,
      minBuyAmount: withSlippage,
      raw: { amountIn, amountOut, takerData },
    };
  }

  async execute(_quote: SwapQuote, _signer: Signer): Promise<never> {
    throw new VenueError("1inch-aqua", "execute is not wired up yet");
  }
}

function defaultClient(): PublicClient {
  return createPublicClient({
    chain: base,
    transport: http(process.env.BASE_RPC_URL ?? "https://mainnet.base.org"),
  }) as PublicClient;
}
