import { fetchCandles, type Bar } from "@/lib/oanda";
export type { Bar };

// ── Session definitions (UTC) ──────────────────────────────────────────
export const SESSIONS = [
  { name: "ASIA", label: "Asia / Pacific", start: 0, end: 360 },
  { name: "LONDON", label: "London / Europe", start: 360, end: 720 },
  { name: "NY", label: "New York", start: 810, end: 1200 },
] as const;

export function getSessionForMinute(minuteOfDay: number): string {
  for (const s of SESSIONS) {
    if (minuteOfDay >= s.start && minuteOfDay < s.end) return s.name;
  }
  return "OUTSIDE";
}

export interface CP {
  price: number;
  time: string;
  type: "HIGH" | "LOW";
}

export interface MSSEvent {
  id: string;
  timestamp: string;
  direction: "BULL" | "BEAR";
  price: number;
  control_point_price: number;
  displacement_quality: number;
  is_accepted: boolean;
  rejection_reason: string | null;
  session: string;
  distance_to_pdh: number | null;
  distance_to_pdl: number | null;
  regime: string | null;
  volatility_state: string | null;
  trend_strength_score: number | null;
  trend_direction: string | null;
  volume_state: string | null;
  vwap: number | null;
  poc: number | null;
  vah: number | null;
  val: number | null;
  liquidity_draw_direction: string | null;
  liquidity_magnet_score: number | null;
  htf_bias: string | null;
  mtf_structure_bias: string | null;
  ltf_direction: string | null;
  mtf_alignment_state: string | null;
  mtf_alignment_score: number | null;
  breakout_quality_score: number | null;
  breakout_type: string | null;
  break_strength_score: number | null;
  retest_quality_score: number | null;
  volume_confirmation_score: number | null;
  environment_alignment_score: number | null;
  has_clean_retest: boolean | null;
  closed_beyond_level: boolean | null;
  confluence_score: number | null;
  setup_grade: string | null;
  event_trade_bias: string | null;
  confluence_components: {
    trend: number; regime: number; volatility: number; volume: number;
    liquidity: number; mtf: number; mss: number; breakout: number;
  } | null;
  rvol_ratio: number | null;
  participation_state: string | null;
  volume_spike_flag: boolean | null;
  session_high: number | null;
  session_low: number | null;
  dist_session_high: number | null;
  dist_session_low: number | null;
  context_flags: string[];
  environment_summary: string;
}

export interface LiquidityPool {
  price: number;
  type: "HIGH" | "LOW";
  count: number;
  times: string[];
}

export interface SweepEvent {
  timestamp: string;
  direction: "BULL" | "BEAR";
  pool_price: number;
  wick_price: number;
  close_price: number;
}

// ── Data fetching (delegates to OANDA) ────────────────────────────────
export async function fetchBars(
  symbol: string,
  start: string,
  end: string,
  timeframe = "1Min",
): Promise<Bar[]> {
  return fetchCandles(symbol, start, end, timeframe);
}

// ── ATR(14) ────────────────────────────────────────────────────────────
export function computeATR(bars: Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const slice = trs.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// ── Control points (swing high/low) ───────────────────────────────────
export function identifyControlPoints(bars: Bar[], lookback = 5): CP[] {
  const points: CP[] = [];
  for (let i = lookback; i < bars.length - lookback; i++) {
    const window = bars.slice(i - lookback, i + lookback + 1);
    const maxH = Math.max(...window.map(b => b.h));
    const minL = Math.min(...window.map(b => b.l));
    if (bars[i].h === maxH) points.push({ price: bars[i].h, time: bars[i].t, type: "HIGH" });
    if (bars[i].l === minL) points.push({ price: bars[i].l, time: bars[i].t, type: "LOW" });
  }
  points.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
  return points;
}

// ── Displacement check ────────────────────────────────────────────────
const ATR_MULT = 1.2;
const MIN_BODY = 0.60;
const MAX_WICK = 0.20;

export function checkDisplacement(bar: Bar, atr: number): { ok: boolean; quality: number } {
  const range = bar.h - bar.l;
  if (range <= 0 || atr <= 0) return { ok: false, quality: 0 };

  const body = Math.abs(bar.c - bar.o);
  const isBull = bar.c > bar.o;
  const oppWick = isBull ? (bar.o - bar.l) : (bar.h - bar.o);

  const threshold = ATR_MULT * atr;
  const rangeRatio = range / threshold;
  const bodyRatio = body / range;
  const wickRatio = oppWick / range;

  const ok = range >= threshold && bodyRatio >= MIN_BODY && wickRatio <= MAX_WICK;

  const sizeScore = Math.min(rangeRatio / 2.0, 1.0);
  let bodyScore = Math.min((bodyRatio - MIN_BODY) / 0.40 + 0.5, 1.0);
  bodyScore = Math.max(bodyScore, 0);
  const wickScore = Math.max(1.0 - wickRatio / MAX_WICK, 0);
  let quality = (sizeScore + bodyScore + wickScore) / 3.0;
  if (!ok) quality = Math.min(quality, 0.49);

  return { ok, quality: Math.round(quality * 1000) / 1000 };
}

// ── Acceptance check ──────────────────────────────────────────────────
export function checkAcceptance(
  direction: "BULL" | "BEAR", cpPrice: number, bars: Bar[], triggerIdx: number,
): { ok: boolean; reason: string | null } {
  const nextBars = bars.slice(triggerIdx + 1, triggerIdx + 3);
  if (nextBars.length === 0) {
    return { ok: false, reason: "no candles available after MSS trigger" };
  }
  for (let i = 0; i < nextBars.length; i++) {
    if (direction === "BULL" && nextBars[i].c < cpPrice) {
      return { ok: false, reason: `candle ${i + 1} closed at ${nextBars[i].c.toFixed(2)}, below CP ${cpPrice.toFixed(2)}` };
    }
    if (direction === "BEAR" && nextBars[i].c > cpPrice) {
      return { ok: false, reason: `candle ${i + 1} closed at ${nextBars[i].c.toFixed(2)}, above CP ${cpPrice.toFixed(2)}` };
    }
  }
  return { ok: true, reason: null };
}

// ── MSS detection ─────────────────────────────────────────────────────
export function detectMSS(
  bars: Bar[], cps: CP[], atr: number,
  pdh: number | null, pdl: number | null,
  regimes?: { time: string; regime: string }[],
): MSSEvent[] {
  if (!cps.length || !bars.length) return [];

  // Build regime lookup map by timestamp
  const regimeMap = new Map<string, string>();
  if (regimes) {
    for (const r of regimes) regimeMap.set(r.time, r.regime);
  }

  const events: MSSEvent[] = [];
  let latestHigh: CP | null = null;
  let latestLow: CP | null = null;
  let cpIdx = 0;
  const usedCPs = new Set<string>();
  let counter = 0;

  for (let bi = 0; bi < bars.length; bi++) {
    const bar = bars[bi];
    const barTime = new Date(bar.t).getTime();

    while (cpIdx < cps.length && new Date(cps[cpIdx].time).getTime() <= barTime) {
      const cp = cps[cpIdx];
      if (cp.type === "HIGH") latestHigh = cp;
      else latestLow = cp;
      cpIdx++;
    }

    const close = bar.c;
    const barDt = new Date(bar.t);
    const minuteOfDay = barDt.getUTCHours() * 60 + barDt.getUTCMinutes();
    const session = getSessionForMinute(minuteOfDay);

    // Bull MSS
    if (latestHigh && !usedCPs.has(latestHigh.time + latestHigh.price)) {
      if (close > latestHigh.price) {
        const disp = checkDisplacement(bar, atr);
        if (disp.ok) {
          counter++;
          const accepted = checkAcceptance("BULL", latestHigh.price, bars, bi);
          events.push({
            id: `MSS_${String(counter).padStart(3, "0")}`,
            timestamp: bar.t,
            direction: "BULL",
            price: close,
            control_point_price: latestHigh.price,
            displacement_quality: disp.quality,
            is_accepted: accepted.ok,
            rejection_reason: accepted.reason,
            session,
            distance_to_pdh: pdh !== null ? Math.round((close - pdh) * 100) / 100 : null,
            distance_to_pdl: pdl !== null ? Math.round((close - pdl) * 100) / 100 : null,
            regime: regimeMap.get(bar.t) ?? null,
            volatility_state: null,
            trend_strength_score: null,
            trend_direction: null,
            volume_state: null,
            vwap: null,
            poc: null,
            vah: null,
            val: null,
            liquidity_draw_direction: null,
            liquidity_magnet_score: null,
            htf_bias: null,
            mtf_structure_bias: null,
            ltf_direction: null,
            mtf_alignment_state: null,
            mtf_alignment_score: null,
            breakout_quality_score: null,
            breakout_type: null,
            break_strength_score: null,
            retest_quality_score: null,
            volume_confirmation_score: null,
            environment_alignment_score: null,
            has_clean_retest: null,
            closed_beyond_level: null,
            confluence_score: null,
            setup_grade: null,
            event_trade_bias: null,
            confluence_components: null,
            rvol_ratio: null,
            participation_state: null,
            volume_spike_flag: null,
            session_high: null,
            session_low: null,
            dist_session_high: null,
            dist_session_low: null,
            context_flags: [],
            environment_summary: "",
          });
          usedCPs.add(latestHigh.time + latestHigh.price);
        }
      }
    }

    // Bear MSS
    if (latestLow && !usedCPs.has(latestLow.time + latestLow.price)) {
      if (close < latestLow.price) {
        const disp = checkDisplacement(bar, atr);
        if (disp.ok) {
          counter++;
          const accepted = checkAcceptance("BEAR", latestLow.price, bars, bi);
          events.push({
            id: `MSS_${String(counter).padStart(3, "0")}`,
            timestamp: bar.t,
            direction: "BEAR",
            price: close,
            control_point_price: latestLow.price,
            displacement_quality: disp.quality,
            is_accepted: accepted.ok,
            rejection_reason: accepted.reason,
            session,
            distance_to_pdh: pdh !== null ? Math.round((close - pdh) * 100) / 100 : null,
            distance_to_pdl: pdl !== null ? Math.round((close - pdl) * 100) / 100 : null,
            regime: regimeMap.get(bar.t) ?? null,
            volatility_state: null,
            trend_strength_score: null,
            trend_direction: null,
            volume_state: null,
            vwap: null,
            poc: null,
            vah: null,
            val: null,
            liquidity_draw_direction: null,
            liquidity_magnet_score: null,
            htf_bias: null,
            mtf_structure_bias: null,
            ltf_direction: null,
            mtf_alignment_state: null,
            mtf_alignment_score: null,
            breakout_quality_score: null,
            breakout_type: null,
            break_strength_score: null,
            retest_quality_score: null,
            volume_confirmation_score: null,
            environment_alignment_score: null,
            has_clean_retest: null,
            closed_beyond_level: null,
            confluence_score: null,
            setup_grade: null,
            event_trade_bias: null,
            confluence_components: null,
            rvol_ratio: null,
            participation_state: null,
            volume_spike_flag: null,
            session_high: null,
            session_low: null,
            dist_session_high: null,
            dist_session_low: null,
            context_flags: [],
            environment_summary: "",
          });
          usedCPs.add(latestLow.time + latestLow.price);
        }
      }
    }
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}

// ── Daily extremes (PDH/PDL) ──────────────────────────────────────────
export function computeDailyExtremes(bars: Bar[]): { pdh: number | null; pdl: number | null; date: string | null } {
  if (!bars.length) return { pdh: null, pdl: null, date: null };
  let bestH = bars[0].h, bestL = bars[0].l;
  for (const b of bars) {
    if (b.h > bestH) bestH = b.h;
    if (b.l < bestL) bestL = b.l;
  }
  return { pdh: bestH, pdl: bestL, date: new Date(bars[0].t).toISOString().slice(0, 10) };
}

// ── Liquidity pools — cluster swing highs/lows within tolerance ──────
export function findLiquidityPools(cps: CP[], tolerancePct = 0.001): LiquidityPool[] {
  const pools: LiquidityPool[] = [];

  for (const type of ["HIGH", "LOW"] as const) {
    const filtered = cps.filter(cp => cp.type === type).sort((a, b) => a.price - b.price);
    let i = 0;
    while (i < filtered.length) {
      const cluster = [filtered[i]];
      let j = i + 1;
      while (j < filtered.length && (filtered[j].price - cluster[0].price) / cluster[0].price <= tolerancePct) {
        cluster.push(filtered[j]);
        j++;
      }
      if (cluster.length >= 2) {
        const avgPrice = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
        pools.push({
          price: Math.round(avgPrice * 100) / 100,
          type,
          count: cluster.length,
          times: cluster.map(c => c.time),
        });
      }
      i = j;
    }
  }

  return pools;
}

// ── Sweep detection — wick through pool + body close back ────────────
export function detectSweeps(bars: Bar[], pools: LiquidityPool[], atr: number): SweepEvent[] {
  if (!pools.length || !bars.length || atr <= 0) return [];

  const events: SweepEvent[] = [];
  const usedPools = new Set<number>();

  for (const bar of bars) {
    for (let pi = 0; pi < pools.length; pi++) {
      if (usedPools.has(pi)) continue;
      const pool = pools[pi];

      if (pool.type === "HIGH") {
        // Wick above pool, body closes back below
        if (bar.h > pool.price && bar.c < pool.price && bar.o < pool.price) {
          events.push({
            timestamp: bar.t,
            direction: "BEAR",
            pool_price: pool.price,
            wick_price: bar.h,
            close_price: bar.c,
          });
          usedPools.add(pi);
        }
      } else {
        // Wick below pool, body closes back above
        if (bar.l < pool.price && bar.c > pool.price && bar.o > pool.price) {
          events.push({
            timestamp: bar.t,
            direction: "BULL",
            pool_price: pool.price,
            wick_price: bar.l,
            close_price: bar.c,
          });
          usedPools.add(pi);
        }
      }
    }
  }

  events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  return events;
}
