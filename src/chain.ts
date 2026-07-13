import { createPublicClient, encodeFunctionData, getAddress, http, maxUint256, parseUnits, type Hex } from "viem";
import { config } from "./config";
import { appGet } from "./appClient";

/**
 * Node-less chain access for the gateway: reads via a hosted RPC (no own node),
 * plus pure calldata encoding. Addresses come from the app's /api/contracts.
 */

const publicClient = createPublicClient({ transport: http(config.rpcUrl) });

const EIP712_DOMAIN_ABI = [
  {
    type: "function",
    name: "eip712Domain",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
  },
] as const;

export interface Addresses {
  forwarder: string;
  stakeEngine: string;
  postRegistry: string;
  vspToken: string;
  /** Optional — live score reads degrade gracefully when not exposed. */
  scoreEngine: string | null;
}

let _addrs: Addresses | null = null;

export async function getAddresses(): Promise<Addresses> {
  if (_addrs) return _addrs;
  const c = await appGet<Record<string, string>>("/contracts");
  const pick = (...keys: string[]) => {
    for (const k of keys) if (c[k]) return getAddress(c[k]);
    throw new Error(`Missing address for ${keys[0]} in /api/contracts`);
  };
  const pickOptional = (...keys: string[]) => {
    for (const k of keys) if (c[k]) return getAddress(c[k]);
    return null;
  };
  _addrs = {
    forwarder: pick("Forwarder", "forwarder"),
    stakeEngine: pick("StakeEngine", "stakeEngine"),
    postRegistry: pick("PostRegistry", "postRegistry"),
    vspToken: pick("VSPToken", "vspToken"),
    scoreEngine: pickOptional("ScoreEngine", "scoreEngine"),
  };
  return _addrs;
}

/** EIP-3085 chain params (for wallet_switchEthereumChain / wallet_addEthereumChain). */
export interface ChainParams {
  chainId: string; // hex, e.g. "0xa869"
  chainName: string;
  rpcUrls: string[];
  nativeCurrency: { name: string; symbol: string; decimals: number };
  blockExplorerUrls: string[];
}

const CHAIN_META: Record<number, { chainName: string; explorer: string }> = {
  43113: { chainName: "Avalanche Fuji C-Chain", explorer: "https://testnet.snowtrace.io" },
  43114: { chainName: "Avalanche C-Chain", explorer: "https://snowtrace.io" },
};

export interface RelayConfig {
  chainId: number;
  forwarder: { address: string; name: string; version: string };
  /** VSPToken EIP-712 domain — needed to sign EIP-2612 permits. */
  token: { address: string; name: string; version: string };
  /** Posting fee in wei (used as the createClaim permit value). */
  postingFeeWei: string;
  addresses: Addresses;
  /** Chain params so the extension can guard/switch the wallet's network. */
  chain: ChainParams;
}

async function readDomain(address: string): Promise<{ name: string; version: string }> {
  const d = (await publicClient.readContract({
    address: address as Hex,
    abi: EIP712_DOMAIN_ABI,
    functionName: "eip712Domain",
  })) as readonly unknown[];
  return { name: String(d[1]), version: String(d[2]) };
}

let _relayCfg: RelayConfig | null = null;

export async function getRelayConfig(): Promise<RelayConfig> {
  if (_relayCfg) return _relayCfg;
  const addresses = await getAddresses();
  const [fwd, tok, fees] = await Promise.all([
    readDomain(addresses.forwarder),
    readDomain(addresses.vspToken),
    appGet<{ posting_fee_wei?: string }>("/fees").catch(() => ({} as { posting_fee_wei?: string })),
  ]);
  const meta = CHAIN_META[config.chainId];
  _relayCfg = {
    chainId: config.chainId,
    forwarder: { address: addresses.forwarder, ...fwd },
    token: { address: addresses.vspToken, ...tok },
    postingFeeWei: String(fees?.posting_fee_wei ?? "1000000000000000000"),
    addresses,
    chain: {
      chainId: "0x" + config.chainId.toString(16),
      chainName: meta?.chainName ?? `Chain ${config.chainId}`,
      rpcUrls: [config.rpcUrl],
      nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
      blockExplorerUrls: meta?.explorer ? [meta.explorer] : [],
    },
  };
  return _relayCfg;
}

const POST_TOTALS_ABI = [
  {
    type: "function",
    name: "getPostTotals",
    stateMutability: "view",
    inputs: [{ name: "postId", type: "uint256" }],
    outputs: [
      { name: "support", type: "uint256" },
      { name: "challenge", type: "uint256" },
    ],
  },
] as const;

const SCORE_ABI = [
  { type: "function", name: "baseVSRay", stateMutability: "view", inputs: [{ name: "postId", type: "uint256" }], outputs: [{ type: "int256" }] },
  { type: "function", name: "effectiveVSRay", stateMutability: "view", inputs: [{ name: "postId", type: "uint256" }], outputs: [{ type: "int256" }] },
] as const;

export interface LivePost {
  supportWei: bigint;
  challengeWei: bigint;
  /** Base / effective VS on the extension's [-100, +100] scale; null if unreadable. */
  baseVs: number | null;
  effectiveVs: number | null;
}

/**
 * Live post state straight from the contracts — the source of truth. The app's
 * indexer can lag the chain by minutes; these views never do (ScoreEngine's
 * VS functions are pure views over current stake + edge state).
 */
export async function getLivePost(postId: number): Promise<LivePost> {
  const a = await getAddresses();
  const pid = BigInt(postId);
  const rayToVs = (ray: bigint) => (Number(ray) / 1e18) * 100;

  const [totals, baseRay, effRay] = await Promise.all([
    publicClient.readContract({
      address: a.stakeEngine as Hex,
      abi: POST_TOTALS_ABI,
      functionName: "getPostTotals",
      args: [pid],
    }) as Promise<readonly [bigint, bigint]>,
    a.scoreEngine
      ? (publicClient.readContract({ address: a.scoreEngine as Hex, abi: SCORE_ABI, functionName: "baseVSRay", args: [pid] }) as Promise<bigint>).catch(() => null)
      : Promise.resolve(null),
    a.scoreEngine
      ? (publicClient.readContract({ address: a.scoreEngine as Hex, abi: SCORE_ABI, functionName: "effectiveVSRay", args: [pid] }) as Promise<bigint>).catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    supportWei: totals[0],
    challengeWei: totals[1],
    baseVs: baseRay != null ? rayToVs(baseRay) : null,
    effectiveVs: effRay != null ? rayToVs(effRay) : null,
  };
}

const LOT_ABI = [
  {
    type: "function",
    name: "getUserLotInfo",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "postId", type: "uint256" },
      { name: "side", type: "uint8" },
    ],
    outputs: [
      { name: "amount", type: "uint256" },
      { name: "weightedPosition", type: "uint256" },
      { name: "entryEpoch", type: "uint256" },
      { name: "sideTotal", type: "uint256" },
      { name: "positionWeight", type: "uint256" },
    ],
  },
] as const;

export interface LotInfo {
  /** Current projected value of the lot (principal ± settlement gains/losses), VSP. */
  projectedVsp: number;
  entryEpoch: number;
  /** Early-staker advantage, 0..1 (1 = front of the queue). */
  positionWeight: number;
  /** The whole side's total, VSP. */
  sideTotalVsp: number;
}

/** A user's live position on a post, both sides, straight from StakeEngine. */
export async function getUserLot(postId: number, user: string): Promise<{ support: LotInfo | null; challenge: LotInfo | null }> {
  const a = await getAddresses();
  const addr = getAddress(user);
  const read = async (side: 0 | 1): Promise<LotInfo | null> => {
    const [amount, , entryEpoch, sideTotal, positionWeight] = (await publicClient.readContract({
      address: a.stakeEngine as Hex,
      abi: LOT_ABI,
      functionName: "getUserLotInfo",
      args: [addr, BigInt(postId), side],
    })) as readonly [bigint, bigint, bigint, bigint, bigint];
    if (amount === 0n) return null;
    return {
      projectedVsp: Number(amount) / 1e18,
      entryEpoch: Number(entryEpoch),
      positionWeight: Number(positionWeight) / 1e18,
      sideTotalVsp: Number(sideTotal) / 1e18,
    };
  };
  const [support, challenge] = await Promise.all([read(0), read(1)]);
  return { support, challenge };
}

/** Build the {to, data, permitValueWei} for a supported write action. */
export async function buildTx(
  action: "setStake" | "createClaim" | "approve",
  params: Record<string, unknown>,
): Promise<{ to: string; data: Hex; permitValueWei: string }> {
  const a = await getAddresses();
  if (action === "approve") {
    const spender = getAddress(String(params.spender));
    const data = encodeFunctionData({
      abi: [{ name: "approve", type: "function", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] }],
      functionName: "approve",
      args: [spender, maxUint256],
    });
    return { to: a.vspToken, data, permitValueWei: "0" };
  }
  if (action === "setStake") {
    const postId = BigInt(params.postId as number);
    const targetVsp = Number(params.targetVsp);
    const absWei = parseUnits(String(Math.abs(targetVsp)), 18);
    const targetWei = targetVsp >= 0 ? absWei : -absWei;
    const data = encodeFunctionData({
      abi: [{ name: "setStake", type: "function", stateMutability: "nonpayable", inputs: [{ name: "postId", type: "uint256" }, { name: "target", type: "int256" }], outputs: [] }],
      functionName: "setStake",
      args: [postId, targetWei],
    });
    // BOTH sides escrow VSP (StakeEngine.setStake transferFroms for support AND
    // challenge), so any nonzero target needs allowance/permit for |target|.
    // Only a full withdraw (target 0) is free.
    return { to: a.stakeEngine, data, permitValueWei: targetVsp !== 0 ? absWei.toString() : "0" };
  }
  // createClaim — permit must cover the posting fee.
  const text = String(params.text ?? "");
  const data = encodeFunctionData({
    abi: [{ name: "createClaim", type: "function", stateMutability: "nonpayable", inputs: [{ name: "text_", type: "string" }], outputs: [{ name: "postId", type: "uint256" }] }],
    functionName: "createClaim",
    args: [text],
  });
  const { postingFeeWei } = await getRelayConfig();
  return { to: a.postRegistry, data, permitValueWei: postingFeeWei };
}
