// Token Radar's value model: one sealed snapshot in, one ranked board out.
//
// The snapshot splits in two. Protocols whose token already trades (a gecko_id or a symbol recorded,
// with a market cap) are the comparables: each category's median market-cap-to-TVL ratio says what the
// market pays per dollar of TVL for that kind of protocol. Protocols that record no token are the board:
// their implied value is what a token would be worth at their category's multiple if the record held.
//
//   peer_multiple = exp((n log m_cat + K log m_all) / (n + K))   median mcap/TVL, shrunk to the market's
//   growth_mult   = 1 + clamp(change_7d, -40, 60) / 100 x 0.5   seven-day TVL trend, half weight
//   runway_mult   = 0.5 + 0.5 x min(days listed, 730) / 730      a longer record with no token, more owed
//   implied       = round(tvl_usd x peer_multiple x growth_mult x runway_mult)
//
// No protocol name is special-cased: every figure comes from the snapshot's own fields, and the same
// function scores every row, the trading comparables included (so the page can show the model's error).

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export interface ModelConstants {
  shrink_k: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_floor: number;
  growth_cap: number;
  growth_weight: number;
  runway_floor: number;
  runway_days: number;
  unknown_runway: number;
}

export const MODEL: ModelConstants = {
  shrink_k: 8,
  multiple_floor: 0.05,
  multiple_cap: 4,
  growth_floor: -40,
  growth_cap: 60,
  growth_weight: 0.5,
  runway_floor: 0.5,
  runway_days: 730,
  unknown_runway: 0.6,
};

export const MODEL_VERSION = 'peer-multiple-2';

/** Categories that hold another token's wrapped, staked or bridged form: the watchlist's own exclusions. */
const DERIVATIVE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

const DAY_MS = 86_400_000;
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function hasToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null || p.mcap_usd !== null;
}

/** A pre-token protocol the board may rank: no token recorded and not a wrapped/staked/bridged product. */
export function isCandidate(p: SnapshotProtocol): boolean {
  return (
    !hasToken(p) &&
    !DERIVATIVE_CATEGORIES.has(p.category ?? '') &&
    !VERSIONED.test(p.name) &&
    !WRAPPED_WORD.test(p.name) &&
    !EXCHANGE_PREFIX.test(p.name)
  );
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface PeerMultiple {
  category: string;
  peers: number;
  raw: number | null;
  multiple: number;
}

/** Each category's market-cap-to-TVL multiple from the snapshot's trading protocols, shrunk to the market's. */
export function peerMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { all: number; peers: number; byCategory: Map<string, PeerMultiple> } {
  const groups = new Map<string, number[]>();
  const every: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0 || p.category === 'CEX') continue;
    const r = p.mcap_usd / p.tvl_usd;
    every.push(r);
    const key = p.category ?? 'Uncategorised';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const all = every.length > 0 ? median(every) : 1;
  const byCategory = new Map<string, PeerMultiple>();
  const cats = new Set(snapshot.protocols.map((p) => p.category ?? 'Uncategorised'));
  for (const category of [...cats].sort(cmp)) {
    const rs = groups.get(category) ?? [];
    const raw = rs.length > 0 ? median(rs) : null;
    const n = rs.length;
    const logm = raw === null ? Math.log(all) : (n * Math.log(raw) + model.shrink_k * Math.log(all)) / (n + model.shrink_k);
    byCategory.set(category, { category, peers: n, raw: raw === null ? null : round4(raw), multiple: round4(clamp(Math.exp(logm), model.multiple_floor, model.multiple_cap)) });
  }
  return { all: round4(all), peers: every.length, byCategory };
}

export interface Valuation {
  implied: number;
  multiple: number;
  growth_pct: number;
  growth_mult: number;
  runway_mult: number;
  age_days: number | null;
}

export function value(p: SnapshotProtocol, asOf: string, multiple: number, model: ModelConstants = MODEL): Valuation {
  const age = ageDays(asOf, p.listed_at);
  const growth = clamp(p.change_7d ?? 0, model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growth / 100) * model.growth_weight;
  const runway = age === null ? model.unknown_runway : model.runway_floor + (1 - model.runway_floor) * (Math.min(age, model.runway_days) / model.runway_days);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * growthMult * runway));
  return { implied, multiple, growth_pct: round4(growth), growth_mult: round4(growthMult), runway_mult: round4(runway), age_days: age };
}

// ---------------------------------------------------------------- farm plans

/** Typical cost of one simple transaction in US cents, by chain. Unlisted chains read DEFAULT_TX_CENTS. */
const TX_CENTS: Record<string, number> = {
  Ethereum: 150, Bitcoin: 150, Tron: 100, Cardano: 20, Avalanche: 5, Binance: 5, Polygon: 2, Arbitrum: 3,
  Base: 2, Optimism: 2, Linea: 3, Scroll: 3, 'zkSync Era': 3, Unichain: 2, Ink: 2, Mantle: 2, Blast: 2,
  Katana: 2, Monad: 2, Sonic: 2, Plasma: 1, Berachain: 2, 'Hyperliquid L1': 1, Sei: 1, Solana: 1, Sui: 1,
  Aptos: 1, Ripple: 1, Stellar: 1, Algorand: 1, TON: 3, Near: 1, Noble: 1, Flare: 1, Celo: 1, xDai: 1,
};
const DEFAULT_TX_CENTS = 10;

/** The wallet a chain's farmer needs, by chain; every chain not named here is EVM-compatible or generic. */
const WALLETS: Record<string, string> = {
  Solana: 'Phantom', Bitcoin: 'Xverse', Sui: 'Slush', Aptos: 'Petra', Tron: 'TronLink', Ripple: 'Xaman',
  Stellar: 'Freighter', Algorand: 'Pera', Cardano: 'Lace', TON: 'Tonkeeper', Noble: 'Keplr', 'Babylon Genesis': 'Keplr',
  Near: 'Meteor', Bittensor: 'Talisman', CORE: 'Rabby', Mezo: 'Rabby',
};
const NON_EVM = new Set(Object.keys(WALLETS).filter((c) => WALLETS[c] !== 'Rabby'));

function usd(cents: number): string {
  if (cents < 100) return `$${(cents / 100).toFixed(2)}`;
  return `$${Math.round(cents / 100).toLocaleString('en-US')}`;
}
function gasOf(chain: string): number {
  return TX_CENTS[chain] ?? DEFAULT_TX_CENTS;
}

/** The chain to farm on: the cheapest one the protocol counts TVL on, first listed on a tie. */
export function farmChain(p: SnapshotProtocol): string {
  if (p.chains.length === 0) return 'Ethereum';
  let best = p.chains[0]!;
  for (const c of p.chains) if (gasOf(c) < gasOf(best)) best = c;
  return best;
}

/** One farm step: the action, what it costs and how long it takes. */
export type Step = [action: string, cost: string, time: string];

/** The capital one position needs, scaled to the protocol's TVL so the position is never a whale's. */
export function capitalFor(tvl: number): number {
  if (tvl >= 1e9) return 2000;
  if (tvl >= 2.5e8) return 1000;
  if (tvl >= 5e7) return 500;
  if (tvl >= 1.5e7) return 250;
  return 100;
}

/** Days to hold: a younger record is earlier in any points season, so it gets the longer hold. */
export function holdDays(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

type Kind = 'curator' | 'vault' | 'lending' | 'cdp' | 'dex' | 'perps' | 'rwa' | 'basis' | 'restake' | 'chain' | 'payments' | 'insurance' | 'prediction' | 'generic';

export function kindOf(category: string | null): Kind {
  const c = (category ?? '').toLowerCase();
  if (c.includes('curator')) return 'curator';
  if (c.includes('allocator') || c.includes('aggregator') || c.includes('liquidity manager') || c.includes('options vault') || c.includes('indexes') || c === 'yield' || c.includes('farm')) return 'vault';
  if (c.includes('cdp') || c.includes('stable') || c.includes('algo')) return 'cdp';
  if (c.includes('lending') || c.includes('collateral management')) return 'lending';
  if (c.includes('dex')) return 'dex';
  if (c.includes('derivative') || c.includes('perp') || c.includes('options') || c.includes('synthetic')) return 'perps';
  if (c.includes('rwa')) return 'rwa';
  if (c.includes('basis') || c.includes('cedefi')) return 'basis';
  if (c.includes('restak') || c.includes('staking pool') || c.includes('collateral markets') || c.includes('btc') || c.includes('governance')) return 'restake';
  if (c === 'chain') return 'chain';
  if (c.includes('payments') || c.includes('card')) return 'payments';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('prediction')) return 'prediction';
  return 'generic';
}

/** The category's core position and its follow-up, in a farmer's words. */
function playbook(kind: Kind, name: string, chain: string, cap: number, tx: number): Step[] {
  const c = `$${cap.toLocaleString('en-US')}`;
  const half = `$${(cap / 2).toLocaleString('en-US')}`;
  const g = (n: number): string => `about ${usd(tx * n)} of gas`;
  switch (kind) {
    case 'curator':
      return [
        [`Deposit ${c} of USDC into the largest USDC vault ${name} curates on ${chain}; the vault page lists its curator and the markets it lends into`, `${c} of capital plus ${g(2)} (approve and deposit)`, '15 minutes'],
        [`Read the vault's allocation and move ${half} into ${name}'s second vault on another chain it curates, so the deposit spans two vault snapshots`, `${g(4)} plus a bridge fee near $1`, '30 minutes'],
      ];
    case 'vault':
      return [
        [`Deposit ${c} of USDC (or ETH where the vault takes only ETH) into ${name}'s flagship vault on ${chain} and keep the vault shares in the wallet`, `${c} of capital plus ${g(2)}`, '15 minutes'],
        [`Check that the shares show on ${name}'s points or portfolio page; if a lock-up boost is offered, lock only the half you will not need for its full term`, `${g(1)}; locked capital cannot be withdrawn early`, '10 minutes'],
      ];
    case 'lending':
      return [
        [`Supply ${c} of USDC on ${name} on ${chain} and enable it as collateral`, `${c} of capital plus ${g(2)}`, '10 minutes'],
        [`Borrow 25% of the supply (${usd(cap * 25)}) in a second stablecoin and leave it supplied in the same market, keeping the health factor above 2.5`, `${g(2)}; the borrow rate minus the supply rate, often 1-3% a year`, '10 minutes'],
      ];
    case 'cdp':
      return [
        [`Mint ${name}'s stablecoin on ${chain} against ${c} of collateral at a ratio of 250% or more, or buy ${c} of it on the chain's main DEX if minting is closed`, `${c} of capital, a mint or swap fee near 0.1%, ${g(2)}`, '15 minutes'],
        [`Deposit the stablecoin into ${name}'s savings or stability module so it earns and counts as active supply`, `${g(2)}`, '10 minutes'],
      ];
    case 'dex':
      return [
        [`Add ${c} of liquidity to ${name}'s deepest stable or blue-chip pool on ${chain}, with a range of about ±2% if the pool is concentrated`, `${c} of capital, ${g(3)}, and impermanent loss on volatile pairs`, '20 minutes'],
        [`Swap ${half} through ${name} each week in two trades so the wallet shows trading volume as well as liquidity`, `the pool fee, about 0.05-0.3% of ${half}, plus ${g(2)} a week`, '5 minutes a week'],
      ];
    case 'perps':
      return [
        [`Deposit ${c} of USDC as margin on ${name} on ${chain} and open matched long and short positions of ${half} each, so price moves cancel out`, `${c} of margin, taker fees near 0.05% a side, ${g(3)}`, '20 minutes'],
        // Closing and reopening both legs is four trades of half the stake at 0.05%: 0.1% of the stake.
        [`Roll the pair once a week to log volume, or move ${half} into ${name}'s liquidity vault if it runs one`, `about ${usd(cap / 10 + tx * 4)} of fees and gas a week at that size`, '10 minutes a week'],
      ];
    case 'rwa':
      return [
        [`Complete ${name}'s onboarding and KYC, if it asks for them, then mint ${c} of its yield-bearing token on ${chain} with USDC (check the minimum ticket first)`, `${c} of capital, a mint fee of 0-0.5%, ${g(2)}`, '1-3 days for KYC, then 15 minutes'],
        [`Hold the token in the same wallet and record the NAV each week; redeem only through ${name}'s own redemption window`, 'no fee to hold; redemptions can take 1-5 business days', '5 minutes a week'],
      ];
    case 'basis':
      return [
        [`Mint ${c} of ${name}'s delta-neutral dollar on ${chain} with USDC, then stake it into the yield-bearing version`, `${c} of capital, ${g(3)}`, '15 minutes'],
        [`Read the cooldown before staking: an unstake queue of 7 days or more ties the capital up, so stake only what can wait`, 'no fee; capital locked for the cooldown', '5 minutes'],
      ];
    case 'restake':
      return [
        [`Stake or restake ${c} of the asset ${name} takes on ${chain} (BTC, ETH or the chain's native token) and keep the receipt token in the wallet`, `${c} of capital, ${g(3)}`, '20 minutes'],
        [`Delegate the stake to one of ${name}'s operators or pools with a published track record and no slashing history`, `${g(1)}; slashing risk on the staked capital`, '10 minutes'],
      ];
    case 'chain':
      return [
        [`Bridge ${c} of USDC to ${chain} through its canonical bridge and stake or delegate part of it to a validator`, `${c} of capital, a bridge fee of $1-5, ${g(3)}`, '30 minutes'],
        [`Use two of ${chain}'s own apps each week (a swap and a deposit) so the address is active on the chain`, `${g(4)} a week`, '10 minutes a week'],
      ];
    case 'payments':
      return [
        [`Open a ${c} payment channel or account with ${name} on ${chain} through a self-custodial wallet`, `${c} of capital plus ${g(2)} to open and close`, '20 minutes'],
        [`Send and receive three small payments ($5-20) a week through it`, `under ${usd(tx * 6 + 10)} a week in fees`, '10 minutes a week'],
      ];
    case 'insurance':
      return [
        [`Underwrite: deposit ${c} into ${name}'s capital or cover pool on ${chain}, or buy ${c} of cover on a position you already hold`, `${c} of capital at risk of claims, or a premium of 2-5% a year, ${g(2)}`, '15 minutes'],
        [`Read the pool's claim history and lock period before depositing, and keep the policy or pool receipt in the wallet`, 'no fee', '15 minutes'],
      ];
    case 'prediction':
      return [
        [`Fund ${c} of USDC on ${name} on ${chain} and take three small positions in liquid markets`, `${c} of capital, trading fees of 0-2%, ${g(3)}`, '20 minutes'],
        [`Provide ${half} of liquidity to one market, or trade weekly, so the account shows both volume and depth`, `${g(2)} a week`, '10 minutes a week'],
      ];
    default:
      return [
        [`Deposit ${c} of USDC into ${name}'s main product on ${chain} and keep the receipt in the wallet`, `${c} of capital plus ${g(2)}`, '15 minutes'],
        [`Use a second feature of ${name} each week (a swap, a stake or a referral) so the wallet shows more than one action`, `${g(2)} a week`, '10 minutes a week'],
      ];
  }
}

/** A protocol's farm plan: 7 steps, each an action with its cost and time, from its category, chains, TVL and age. */
export function farmPlan(p: SnapshotProtocol, age: number | null): Step[] {
  const chain = farmChain(p);
  const tx = gasOf(chain);
  const cap = capitalFor(p.tvl_usd);
  const hold = holdDays(age);
  const wallet = WALLETS[chain] ?? 'Rabby or MetaMask';
  const evmLike = !NON_EVM.has(chain);
  const others = p.chains.length - 1;
  const why = others > 0 ? `of the ${p.chains.length} chains ${p.name} counts TVL on, ${chain} has the cheapest gas` : `${p.name} counts its TVL on ${chain} alone`;
  const fund: Step = chain === 'Ethereum'
    ? [`Withdraw $${cap.toLocaleString('en-US')} of USDC plus $15 of ETH for gas from an exchange straight to the wallet on Ethereum`, 'an exchange withdrawal fee of about $3-6', '10-30 minutes']
    : evmLike
      ? [`Bridge $${cap.toLocaleString('en-US')} of USDC and $3 of gas to ${chain} with an intent bridge or the chain's canonical bridge, or withdraw directly if your exchange supports ${chain}`, 'a bridge fee of about $1-4', '2-20 minutes']
      : [`Buy or withdraw $${cap.toLocaleString('en-US')} of the chain's USDC (or its native asset) to the ${wallet} wallet on ${chain} from an exchange that lists it`, `a withdrawal fee of about ${usd(Math.max(tx * 2, 50))}-$5`, '10-30 minutes'];
  const forgone = Math.round(cap * 0.04 * hold / 365);
  const exit = p.change_7d === null ? 'no seven-day change is reported, so check TVL weekly' : `TVL moved ${p.change_7d > 0 ? '+' : ''}${p.change_7d.toFixed(1)}% this week`;
  return [
    [`Create a fresh ${wallet} wallet for ${chain} (${why}) that holds only farm funds, and back up its seed phrase offline`, 'free', '5 minutes'],
    fund,
    ...playbook(kindOf(p.category), p.name, chain, cap, tx),
    [`Make one qualifying action each week for ${hold} days (top up, claim, swap or vote) so the wallet appears in every weekly snapshot`, `about ${usd(tx * 2)} of gas a week, ${usd(tx * 2 * Math.ceil(hold / 7))} over the hold`, `10 minutes a week, ${hold} days`],
    [`Exit or halve the position if ${p.name}'s TVL falls more than 25% in one week (${exit}); a falling TVL is a falling share of any reward`, `${usd(tx * 3)} of gas to unwind`, '10 minutes a week to check'],
    [`Log every transaction and the points balance, then claim only from ${p.name}'s own published claim page if a token is announced; never pay to claim`, `nothing but the log; the capital forgoes about $${forgone} of 4% T-bill yield over ${hold} days`, '5 minutes a week'],
  ];
}

export function stepText([action, cost, time]: Step): string {
  return `${action}. Cost: ${cost}. Time: ${time}.`;
}

// ---------------------------------------------------------------- board

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  implied_value_usd: number;
  model: { peer_multiple: number; peers: number; growth_mult: number; runway_mult: number };
  farm_chain: string;
  capital_usd: number;
  hold_days: number;
  farm_steps: string[];
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number;
  symbol: string | null;
  model_value_usd: number;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  market_multiple: number;
  market_peers: number;
  multiples: PeerMultiple[];
  watchlist_size: number;
  protocols_size: number;
  rows: (Omit<BoardRow, 'farm_steps'> & { steps: Step[] })[];
  live: LiveRow[];
}

/** Every pre-token candidate on the watchlist or below its floor, valued and ranked. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const { all, peers, byCategory } = peerMultiples(snapshot, model);
  const watch = new Set(snapshot.watchlist);
  const multipleOf = (p: SnapshotProtocol): PeerMultiple => byCategory.get(p.category ?? 'Uncategorised')!;
  // The watchlist is the floor; below it, every candidate the watchlist's own rule would keep.
  const chosen = snapshot.protocols.filter((p) => watch.has(p.slug) || (isCandidate(p) && p.tvl_usd < snapshot.floor_usd));
  const scored = chosen
    .map((p) => ({ p, m: multipleOf(p), v: value(p, snapshot.as_of, multipleOf(p).multiple, model) }))
    .sort((a, b) => b.v.implied - a.v.implied || cmp(a.p.slug, b.p.slug));
  const rows = scored.map(({ p, m, v }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    age_days: v.age_days,
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(p.slug),
    implied_value_usd: v.implied,
    model: { peer_multiple: m.multiple, peers: m.peers, growth_mult: v.growth_mult, runway_mult: v.runway_mult },
    farm_chain: farmChain(p),
    capital_usd: capitalFor(p.tvl_usd),
    hold_days: holdDays(v.age_days),
    steps: farmPlan(p, v.age_days),
  }));
  const board: BoardRow[] = rows.map(({ steps, ...r }) => ({ ...r, farm_steps: steps.map(stepText) }));
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => hasToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.category !== 'CEX')
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || cmp(a.slug, b.slug))
    .slice(0, 60)
    .map((p) => ({
      slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, change_7d: p.change_7d,
      mcap_usd: p.mcap_usd!, symbol: p.symbol, model_value_usd: value(p, snapshot.as_of, multipleOf(p).multiple, model).implied,
    }));
  const used = new Set(rows.map((r) => r.category ?? 'Uncategorised'));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    market_multiple: all,
    market_peers: peers,
    multiples: [...byCategory.values()].filter((m) => used.has(m.category)).sort((a, b) => b.multiple - a.multiple || cmp(a.category, b.category)),
    watchlist_size: snapshot.watchlist.length,
    protocols_size: snapshot.protocols.length,
    rows,
    live,
  };
  return { board, radar };
}

// ---------------------------------------------------------------- input and gate

export class SnapshotError extends Error {}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new SnapshotError('snapshot.json is not a JSON object');
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.floor_usd !== 'number' || !(o.floor_usd > 0)) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const protocols = o.protocols.map((v, i): SnapshotProtocol => {
    const p = (v ?? {}) as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || num(p.tvl_usd) === null) throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    return {
      slug: p.slug, name: p.name, category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd as number, change_7d: num(p.change_7d), mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at), gecko_id: str(p.gecko_id), symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: String(o.source ?? ''), floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why the gate would refuse this board, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const slugs = new Set(board.map((r) => r.slug));
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, not 100 to 4000`;
  if (slugs.size !== board.length) return 'a slug appears twice';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) {
    const r = board[i]!;
    if (r.rank !== i + 1) return `row ${i} has rank ${r.rank}`;
    if (i > 0 && r.implied_value_usd > board[i - 1]!.implied_value_usd) return `${r.slug} outranks the row above it`;
    if (!known.has(r.slug)) return `${r.slug} is not in the snapshot`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  if (board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row has the same implied value';
  return null;
}

export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
