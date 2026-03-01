import { NextRequest, NextResponse } from "next/server";
import {
  fetchBars,
  computeATR,
  identifyControlPoints,
  detectMSS,
  computeDailyExtremes,
  type Bar,
} from "@/lib/mss-pipeline";
import { computeRegimeSeries, DEFAULT_REGIME_CONFIG, computeADX } from "@/lib/regime";

// ── Participation / RVOL config ───────────────────────────────────────
const RVOL_LOOKBACK_DAYS = 20;
const RVOL_BUCKET_SIZE_MIN = 5;
const RVOL_MIN_BARS_PER_BUCKET = 10;
const RVOL_LOW_THRESHOLD = 0.7;
const RVOL_HIGH_THRESHOLD = 1.5;
const RVOL_EXTREME_THRESHOLD = 3.0;
const RVOL_SPIKE_THRESHOLD = 3.0;

// ── Volatility helpers ────────────────────────────────────────────────
const VOL_ATR_PERIOD = 14;
const VOL_BASELINE_LOOKBACK = 100;
const VOL_LOW_PCT = 0.7;
const VOL_HIGH_PCT = 1.3;

function computeRollingATR(bars: Bar[], period: number): number[] {
  const trs: number[] = [0]; // first bar has no prev close
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const result: number[] = new Array(bars.length).fill(NaN);
  for (let i = period - 1; i < trs.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += trs[j];
    result[i] = sum / period;
  }
  return result;
}

function classifyVolatilitySeries(bars: Bar[]): string[] {
  const rollingAtr = computeRollingATR(bars, VOL_ATR_PERIOD);
  const states: string[] = new Array(bars.length).fill("MEDIUM");

  // Compute rolling baseline of ATR
  const baselines: number[] = new Array(bars.length).fill(NaN);
  for (let i = VOL_BASELINE_LOOKBACK - 1; i < bars.length; i++) {
    let sum = 0, count = 0;
    for (let j = i - VOL_BASELINE_LOOKBACK + 1; j <= i; j++) {
      if (!isNaN(rollingAtr[j])) { sum += rollingAtr[j]; count++; }
    }
    if (count > 0) baselines[i] = sum / count;
  }

  for (let i = 0; i < bars.length; i++) {
    const atr = rollingAtr[i];
    const base = baselines[i];
    if (isNaN(atr) || isNaN(base)) { states[i] = "MEDIUM"; continue; }
    if (atr <= base * VOL_LOW_PCT) states[i] = "LOW";
    else if (atr >= base * VOL_HIGH_PCT) states[i] = "HIGH";
    else states[i] = "MEDIUM";
  }
  return states;
}

// ── Volume helpers ────────────────────────────────────────────────────
const VOL_NUM_BINS = 40;
const VOL_VALUE_AREA_FRACTION = 0.70;
const VOL_ACCEPTANCE_MIN_BARS = 3;

type VolumeState = "IN_VALUE" | "ACCEPTING_ABOVE" | "ACCEPTING_BELOW" | "REJECTING_ABOVE" | "REJECTING_BELOW";

interface VolumePoint {
  time: string;
  vwap: number;
  poc: number;
  vah: number;
  val: number;
  state: VolumeState;
}

function computeSessionVWAP(bars: Bar[]): number[] {
  const result: number[] = new Array(bars.length).fill(NaN);
  let cumNum = 0, cumDen = 0;
  for (let i = 0; i < bars.length; i++) {
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cumNum += tp * bars[i].v;
    cumDen += bars[i].v;
    result[i] = cumDen > 0 ? cumNum / cumDen : NaN;
  }
  return result;
}

function computeVolumeProfile(bars: Bar[]): { poc: number; vah: number; val: number } | null {
  if (bars.length === 0) return null;
  const tps = bars.map((b) => (b.h + b.l + b.c) / 3);
  const priceMin = Math.min(...tps);
  const priceMax = Math.max(...tps);
  if (priceMin === priceMax) return { poc: priceMin, vah: priceMin, val: priceMin };

  const binWidth = (priceMax - priceMin) / VOL_NUM_BINS;
  const binVolumes = new Array(VOL_NUM_BINS).fill(0);
  const binPrices = Array.from({ length: VOL_NUM_BINS }, (_, i) => priceMin + i * binWidth);

  for (let i = 0; i < bars.length; i++) {
    let bi = Math.floor((tps[i] - priceMin) / binWidth);
    bi = Math.max(0, Math.min(VOL_NUM_BINS - 1, bi));
    binVolumes[bi] += bars[i].v;
  }

  let pocBin = 0;
  for (let i = 1; i < VOL_NUM_BINS; i++) {
    if (binVolumes[i] > binVolumes[pocBin]) pocBin = i;
  }
  const poc = binPrices[pocBin];

  const totalVol = binVolumes.reduce((a: number, b: number) => a + b, 0);
  if (totalVol === 0) return { poc, vah: poc, val: poc };

  const target = totalVol * VOL_VALUE_AREA_FRACTION;
  const sortedBins = Array.from({ length: VOL_NUM_BINS }, (_, i) => i).sort(
    (a, b) => binVolumes[b] - binVolumes[a]
  );

  let cumVol = 0;
  const vaBins: number[] = [];
  for (const bi of sortedBins) {
    if (cumVol >= target) break;
    vaBins.push(bi);
    cumVol += binVolumes[bi];
  }

  if (vaBins.length === 0) return { poc, vah: poc, val: poc };
  const vah = binPrices[Math.max(...vaBins)] + binWidth;
  const val = binPrices[Math.min(...vaBins)];
  return { poc, vah, val };
}

function computeVolumeSeries(bars: Bar[]): VolumePoint[] {
  const vwapArr = computeSessionVWAP(bars);
  const profile = computeVolumeProfile(bars);
  const poc = profile?.poc ?? NaN;
  const vah = profile?.vah ?? NaN;
  const val = profile?.val ?? NaN;

  const points: VolumePoint[] = [];
  let aboveCounter = 0, belowCounter = 0;

  for (let i = 0; i < bars.length; i++) {
    const close = bars[i].c;
    const vwap = vwapArr[i];

    if (isNaN(poc) || isNaN(vah) || isNaN(val)) {
      aboveCounter = 0; belowCounter = 0;
      points.push({ time: bars[i].t, vwap, poc, vah, val, state: "IN_VALUE" });
      continue;
    }

    let state: VolumeState;
    if (close >= val && close <= vah) {
      aboveCounter = 0; belowCounter = 0;
      state = "IN_VALUE";
    } else if (close > vah) {
      aboveCounter++; belowCounter = 0;
      state = aboveCounter >= VOL_ACCEPTANCE_MIN_BARS ? "ACCEPTING_ABOVE" : "REJECTING_ABOVE";
    } else {
      belowCounter++; aboveCounter = 0;
      state = belowCounter >= VOL_ACCEPTANCE_MIN_BARS ? "ACCEPTING_BELOW" : "REJECTING_BELOW";
    }

    points.push({ time: bars[i].t, vwap, poc, vah, val, state });
  }

  return points;
}

// ── Participation / RVOL helpers ──────────────────────────────────────
type ParticipationState = "LOW_ACTIVITY" | "NORMAL" | "ELEVATED" | "EXTREME";

interface ParticipationPoint {
  time: string;
  rvol_ratio: number;
  participation_state: ParticipationState;
  volume_spike_flag: boolean;
}

function getTodBucket(isoTime: string): number {
  const d = new Date(isoTime);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  return Math.floor(min / RVOL_BUCKET_SIZE_MIN) * RVOL_BUCKET_SIZE_MIN;
}

function classifyParticipationState(rvol: number): ParticipationState {
  if (rvol < RVOL_LOW_THRESHOLD)     return "LOW_ACTIVITY";
  if (rvol < RVOL_HIGH_THRESHOLD)    return "NORMAL";
  if (rvol < RVOL_EXTREME_THRESHOLD) return "ELEVATED";
  return "EXTREME";
}

function computeParticipationSeries(currentBars: Bar[], histBars: Bar[]): ParticipationPoint[] {
  // Build Map<dateStr, Map<bucket, volume>> from historical bars
  const byDateBucket = new Map<string, Map<number, number>>();
  for (const b of histBars) {
    const dateStr = b.t.slice(0, 10);
    const bucket = getTodBucket(b.t);
    if (!byDateBucket.has(dateStr)) byDateBucket.set(dateStr, new Map());
    byDateBucket.get(dateStr)!.set(bucket, b.v);
  }

  // Filter to last RVOL_LOOKBACK_DAYS
  const allDates = Array.from(byDateBucket.keys()).sort();
  const useDates = new Set(allDates.slice(-RVOL_LOOKBACK_DAYS));

  // Aggregate to Map<bucket, {sum, count}>
  const bucketAgg = new Map<number, { sum: number; count: number }>();
  Array.from(byDateBucket.entries()).forEach(([dateStr, bucketMap]) => {
    if (!useDates.has(dateStr)) return;
    Array.from(bucketMap.entries()).forEach(([bucket, vol]) => {
      const prev = bucketAgg.get(bucket) ?? { sum: 0, count: 0 };
      bucketAgg.set(bucket, { sum: prev.sum + vol, count: prev.count + 1 });
    });
  });

  // Build baseline: bucket → meanVol (only if count >= min)
  const baseline = new Map<number, number>();
  Array.from(bucketAgg.entries()).forEach(([bucket, { sum, count }]) => {
    if (count >= RVOL_MIN_BARS_PER_BUCKET) baseline.set(bucket, sum / count);
  });

  // Compute participation for each current bar
  return currentBars.map((b) => {
    const bucket = getTodBucket(b.t);
    const baseMean = baseline.get(bucket);
    const rvol = baseMean && baseMean > 0 ? Math.round((b.v / baseMean) * 1000) / 1000 : 1.0;
    return {
      time: b.t,
      rvol_ratio: rvol,
      participation_state: classifyParticipationState(rvol),
      volume_spike_flag: rvol >= RVOL_SPIKE_THRESHOLD,
    };
  });
}

// ── Trend Strength helpers ─────────────────────────────────────────────
const TREND_SLOW_EMA = 50;
const TREND_REG_LOOKBACK = 50;
const TREND_STRONG_SLOPE = 0.0005;
const TREND_ADX_CAP = 50;
const TREND_W_ADX = 0.4;
const TREND_W_EMA = 0.3;
const TREND_W_REG = 0.3;
const TREND_MIN_BARS = 60;

function computeEMASeries(closes: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const result: number[] = [closes[0]];
  for (let i = 1; i < closes.length; i++) {
    result.push(closes[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function computeEMASlope(emaSlow: number[], lookback: number): number[] {
  const result: number[] = new Array(emaSlow.length).fill(NaN);
  for (let i = lookback; i < emaSlow.length; i++) {
    const prev = emaSlow[i - lookback];
    if (prev !== 0) result[i] = (emaSlow[i] - prev) / (lookback * prev);
  }
  return result;
}

function computeRegSlope(closes: number[], lookback: number): number[] {
  const result: number[] = new Array(closes.length).fill(NaN);
  const x = Array.from({ length: lookback }, (_, i) => i);
  const xMean = x.reduce((a, b) => a + b, 0) / lookback;
  const ssXX = x.reduce((a, b) => a + (b - xMean) ** 2, 0);

  for (let i = lookback - 1; i < closes.length; i++) {
    const window = closes.slice(i - lookback + 1, i + 1);
    const yMean = window.reduce((a, b) => a + b, 0) / lookback;
    if (yMean === 0) continue;
    let ssXY = 0;
    for (let j = 0; j < lookback; j++) ssXY += (x[j] - xMean) * (window[j] - yMean);
    result[i] = (ssXY / ssXX) / yMean;
  }
  return result;
}

interface TrendPoint {
  time: string;
  score: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
}

function computeTrendSeries(bars: Bar[]): TrendPoint[] {
  const closes = bars.map(b => b.c);
  const adxArr = computeADX(bars, 14);
  const emaSlow = computeEMASeries(closes, TREND_SLOW_EMA);
  const emaSlope = computeEMASlope(emaSlow, TREND_REG_LOOKBACK);
  const regSlope = computeRegSlope(closes, TREND_REG_LOOKBACK);

  return bars.map((b, i) => {
    const adx = adxArr[i];
    const es = emaSlope[i];
    const rs = regSlope[i];

    if (i < TREND_MIN_BARS || isNaN(adx) || isNaN(es) || isNaN(rs)) {
      return { time: b.t, score: 0, direction: "NEUTRAL" as const };
    }

    const adxScore = Math.min(adx, TREND_ADX_CAP) / TREND_ADX_CAP * 100;
    const emaScore = Math.min(Math.abs(es) / TREND_STRONG_SLOPE, 1) * 100;
    const regScore = Math.min(Math.abs(rs) / TREND_STRONG_SLOPE, 1) * 100;

    const raw = adxScore * TREND_W_ADX + emaScore * TREND_W_EMA + regScore * TREND_W_REG;
    const score = Math.round(Math.max(0, Math.min(100, raw)) * 10) / 10;

    let direction: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
    if (es > 0 && rs > 0) direction = "UP";
    else if (es < 0 && rs < 0) direction = "DOWN";

    return { time: b.t, score, direction };
  });
}

// ── Session classification (UTC minutes) ──────────────────────────────
function getBarSession(isoTime: string): "ASIA" | "LONDON" | "NY" | "OUTSIDE" {
  const d = new Date(isoTime);
  const min = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (min >= 0   && min < 360)  return "ASIA";
  if (min >= 360 && min < 720)  return "LONDON";
  if (min >= 810 && min < 1200) return "NY";
  return "OUTSIDE";
}

// ── Session-aware running H/L (resets when session label changes) ──────
function computeSessionHighsLows(bars: Bar[]): { sessionHighs: number[]; sessionLows: number[] } {
  const sessionHighs: number[] = [];
  const sessionLows: number[] = [];
  let prevSess = "";
  let runH = -Infinity, runL = Infinity;
  for (const b of bars) {
    const sess = getBarSession(b.t);
    if (sess !== prevSess) { runH = -Infinity; runL = Infinity; prevSess = sess; }
    if (b.h > runH) runH = b.h;
    if (b.l < runL) runL = b.l;
    sessionHighs.push(runH);
    sessionLows.push(runL);
  }
  return { sessionHighs, sessionLows };
}

// ── Liquidity Draw helpers ─────────────────────────────────────────────
const LQDRAW_DIST_CLIP_ATR  = 3.0;
const LQDRAW_W_SESSION      = 0.25;
const LQDRAW_W_PDH_PDL      = 0.25;
const LQDRAW_W_EQUAL        = 0.25;
const LQDRAW_W_VOLUME       = 0.25;
const LQDRAW_NEUTRAL_BAND   = 0.20;
const LQDRAW_MIN_SCORE      = 20;

type LiquidityDrawDir = "ABOVE" | "BELOW" | "NEUTRAL";

interface LiquidityDrawPoint {
  time: string;
  direction: LiquidityDrawDir;
  magnet_score: number;
  up_score: number;
  down_score: number;
}

function computeLiquidityDrawSeries(
  bars: Bar[],
  cps: ReturnType<typeof identifyControlPoints>,
  pdh: number | null,
  pdl: number | null,
  volumeSeries: VolumePoint[],
  rollingAtr: number[],
  sessionHighs: number[],
  sessionLows: number[],
): LiquidityDrawPoint[] {

  const volMap = new Map<string, VolumePoint>();
  for (const vp of volumeSeries) volMap.set(vp.time, vp);

  const cpHighs = cps.filter((cp) => cp.type === "HIGH");
  const cpLows  = cps.filter((cp) => cp.type === "LOW");

  function levelScore(d: number): number {
    return (1 - Math.min(Math.abs(d), LQDRAW_DIST_CLIP_ATR) / LQDRAW_DIST_CLIP_ATR) * 100;
  }

  const points: LiquidityDrawPoint[] = [];

  for (let i = 0; i < bars.length; i++) {
    const close = bars[i].c;
    const atr   = rollingAtr[i];

    if (isNaN(atr) || atr === 0) {
      points.push({ time: bars[i].t, direction: "NEUTRAL", magnet_score: 0, up_score: 0, down_score: 0 });
      continue;
    }

    let up = 0, dn = 0;
    const barMs = new Date(bars[i].t).getTime();

    // Session high / low
    const shDist = (sessionHighs[i] - close) / atr;
    const slDist = (sessionLows[i]  - close) / atr;
    if (shDist > 0) up += levelScore(shDist) * LQDRAW_W_SESSION;
    if (slDist < 0) dn += levelScore(slDist) * LQDRAW_W_SESSION;

    // PDH / PDL
    if (pdh !== null) { const d = (pdh - close) / atr; if (d > 0) up += levelScore(d) * LQDRAW_W_PDH_PDL; }
    if (pdl !== null) { const d = (pdl - close) / atr; if (d < 0) dn += levelScore(d) * LQDRAW_W_PDH_PDL; }

    // Nearest equal high / low (control points before this bar)
    let nearEH: number | null = null;
    let nearEL: number | null = null;
    for (const cp of cpHighs) {
      if (new Date(cp.time).getTime() >= barMs) continue;
      if (cp.price > close && (nearEH === null || cp.price < nearEH)) nearEH = cp.price;
    }
    for (const cp of cpLows) {
      if (new Date(cp.time).getTime() >= barMs) continue;
      if (cp.price < close && (nearEL === null || cp.price > nearEL)) nearEL = cp.price;
    }
    if (nearEH !== null) { const d = (nearEH - close) / atr; if (d > 0) up += levelScore(d) * LQDRAW_W_EQUAL; }
    if (nearEL !== null) { const d = (nearEL - close) / atr; if (d < 0) dn += levelScore(d) * LQDRAW_W_EQUAL; }

    // Volume magnets (POC / VAH / VAL)
    const vp = volMap.get(bars[i].t);
    if (vp && !isNaN(vp.poc)) {
      let volUp = 0, volDn = 0;
      const pocD = (vp.poc - close) / atr;
      if (pocD > 0) volUp = Math.max(volUp, levelScore(pocD));
      else if (pocD < 0) volDn = Math.max(volDn, levelScore(pocD));
      if (!isNaN(vp.vah)) { const d = (vp.vah - close) / atr; if (d > 0) volUp = Math.max(volUp, levelScore(d)); }
      if (!isNaN(vp.val)) { const d = (vp.val - close) / atr; if (d < 0) volDn = Math.max(volDn, levelScore(d)); }
      up += volUp * LQDRAW_W_VOLUME;
      dn += volDn * LQDRAW_W_VOLUME;
    }

    up = Math.min(Math.max(up, 0), 100);
    dn = Math.min(Math.max(dn, 0), 100);
    const total = up + dn;

    let direction: LiquidityDrawDir;
    let magnetScore: number;
    if (total < LQDRAW_MIN_SCORE) {
      direction = "NEUTRAL"; magnetScore = total;
    } else if (up > dn * (1 + LQDRAW_NEUTRAL_BAND)) {
      direction = "ABOVE"; magnetScore = up;
    } else if (dn > up * (1 + LQDRAW_NEUTRAL_BAND)) {
      direction = "BELOW"; magnetScore = dn;
    } else {
      direction = "NEUTRAL"; magnetScore = Math.max(up, dn);
    }

    points.push({
      time: bars[i].t,
      direction,
      magnet_score: Math.round(magnetScore * 10) / 10,
      up_score: Math.round(up * 10) / 10,
      down_score: Math.round(dn * 10) / 10,
    });
  }

  return points;
}

// ── Multi-Timeframe (MTF) Alignment helpers ────────────────────────────
const MTF_HTF_MIN_STRENGTH    = 50;
const MTF_MTF_MIN_STRENGTH    = 40;
const MTF_FULL_ALIGN_SCORE    = 90;
const MTF_PARTIAL_ALIGN_SCORE = 60;
const MTF_WEAK_ALIGN_SCORE    = 40;
const MTF_CONFLICT_SCORE      = 10;

type HTFBias = "UP" | "DOWN" | "RANGE";
type MTFStructureBias = "LONG_BIAS" | "SHORT_BIAS" | "NEUTRAL";
type MTFAlignState =
  | "FULL_ALIGN_UP" | "FULL_ALIGN_DOWN"
  | "PARTIAL_ALIGN_UP" | "PARTIAL_ALIGN_DOWN"
  | "CONFLICT" | "WEAK_ALIGN";

interface MTFAlignPoint {
  time: string;
  htf_bias: HTFBias;
  mtf_structure_bias: MTFStructureBias;
  ltf_direction: string;
  mtf_alignment_state: MTFAlignState;
  mtf_alignment_score: number;
}

interface TimeSeriesEntry {
  timeMs: number;
  direction: "UP" | "DOWN" | "NEUTRAL";
  score: number;
  regime?: string;
}

function buildTimeIndex(
  trend: TrendPoint[],
  regimes?: { time: string; regime: string }[],
): TimeSeriesEntry[] {
  const regMap = new Map<string, string>();
  if (regimes) for (const r of regimes) regMap.set(r.time, r.regime);
  return trend.map((tp) => ({
    timeMs: new Date(tp.time).getTime(),
    direction: tp.direction,
    score: tp.score,
    regime: regMap.get(tp.time),
  }));
}

function asofLookup(index: TimeSeriesEntry[], timeMs: number): TimeSeriesEntry | null {
  let lo = 0, hi = index.length - 1;
  let result: TimeSeriesEntry | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (index[mid].timeMs <= timeMs) { result = index[mid]; lo = mid + 1; }
    else hi = mid - 1;
  }
  return result;
}

function classifyMTFAlignment(
  htfBias: HTFBias,
  mtfBias: MTFStructureBias,
  ltfDir: string,
  htfStrength: number,
  mtfStrength: number,
  ltfStrength: number,
): { state: MTFAlignState; score: number } {
  const h = htfBias === "UP" ? "UP" : htfBias === "DOWN" ? "DOWN" : "NEUTRAL";
  const m = mtfBias === "LONG_BIAS" ? "UP" : mtfBias === "SHORT_BIAS" ? "DOWN" : "NEUTRAL";
  const l = ltfDir === "UP" ? "UP" : ltfDir === "DOWN" ? "DOWN" : "NEUTRAL";
  const ups   = (h === "UP" ? 1 : 0) + (m === "UP" ? 1 : 0) + (l === "UP" ? 1 : 0);
  const downs = (h === "DOWN" ? 1 : 0) + (m === "DOWN" ? 1 : 0) + (l === "DOWN" ? 1 : 0);

  let state: MTFAlignState;
  let base: number;
  if (ups === 3)                       { state = "FULL_ALIGN_UP";    base = MTF_FULL_ALIGN_SCORE; }
  else if (downs === 3)                { state = "FULL_ALIGN_DOWN";  base = MTF_FULL_ALIGN_SCORE; }
  else if (ups >= 2 && downs === 0)    { state = "PARTIAL_ALIGN_UP"; base = MTF_PARTIAL_ALIGN_SCORE; }
  else if (downs >= 2 && ups === 0)    { state = "PARTIAL_ALIGN_DOWN"; base = MTF_PARTIAL_ALIGN_SCORE; }
  else if (ups > 0 && downs > 0)       { state = "CONFLICT";         base = MTF_CONFLICT_SCORE; }
  else                                 { state = "WEAK_ALIGN";       base = MTF_WEAK_ALIGN_SCORE; }

  const avgStrength = (htfStrength + mtfStrength + ltfStrength) / 3;
  const score = Math.round(
    Math.min(Math.max(base * (0.5 + 0.5 * avgStrength / 100), 0), 100) * 100,
  ) / 100;
  return { state, score };
}

function computeMTFAlignmentSeries(
  ltfBars: Bar[],
  ltfTrend: TrendPoint[],
  mtfIndex: TimeSeriesEntry[],
  htfIndex: TimeSeriesEntry[],
): MTFAlignPoint[] {
  return ltfBars.map((bar, i) => {
    const barMs  = new Date(bar.t).getTime();
    const lt     = ltfTrend[i];
    const htfEnt = asofLookup(htfIndex, barMs);
    const mtfEnt = asofLookup(mtfIndex, barMs);

    const ltfDir = lt?.direction ?? "NEUTRAL";
    const ltfStr = lt?.score ?? 0;
    const htfDir = htfEnt?.direction ?? "NEUTRAL";
    const htfStr = htfEnt?.score ?? 0;
    const htfReg = htfEnt?.regime ?? "TRANSITION";
    const mtfDir = mtfEnt?.direction ?? "NEUTRAL";
    const mtfStr = mtfEnt?.score ?? 0;

    let htfBias: HTFBias;
    if (htfReg === "RANGE") htfBias = "RANGE";
    else if (htfDir === "UP"   && htfStr >= MTF_HTF_MIN_STRENGTH) htfBias = "UP";
    else if (htfDir === "DOWN" && htfStr >= MTF_HTF_MIN_STRENGTH) htfBias = "DOWN";
    else htfBias = "RANGE";

    let mtfBias: MTFStructureBias;
    if (mtfDir === "UP"   && mtfStr >= MTF_MTF_MIN_STRENGTH) mtfBias = "LONG_BIAS";
    else if (mtfDir === "DOWN" && mtfStr >= MTF_MTF_MIN_STRENGTH) mtfBias = "SHORT_BIAS";
    else mtfBias = "NEUTRAL";

    const { state, score } = classifyMTFAlignment(htfBias, mtfBias, ltfDir, htfStr, mtfStr, ltfStr);
    return { time: bar.t, htf_bias: htfBias, mtf_structure_bias: mtfBias, ltf_direction: ltfDir, mtf_alignment_state: state, mtf_alignment_score: score };
  });
}

// ── Breakout Quality helpers ──────────────────────────────────────────
const BKT_LOOKAHEAD            = 10;
const BKT_MIN_CLOSE_BEYOND_ATR = 0.25;
const BKT_STRONG_CLOSE_ATR     = 0.75;
const BKT_MIN_VOL_RELATIVE     = 1.2;
const BKT_STRONG_VOL_RELATIVE  = 2.0;
const BKT_MAX_RETEST_ATR       = 0.5;
const BKT_W_BREAK_STRENGTH     = 0.40;
const BKT_W_RETEST             = 0.30;
const BKT_W_VOLUME             = 0.20;
const BKT_W_ENV                = 0.10;
const BKT_CONTINUATION_THRESH  = 65;
const BKT_FAKEOUT_THRESH       = 35;

type BreakoutType = "CONTINUATION" | "FAKEOUT" | "UNCLEAR";

interface BreakoutResult {
  breakout_quality_score: number;
  breakout_type: BreakoutType;
  break_strength_score: number;
  retest_quality_score: number;
  volume_confirmation_score: number;
  environment_alignment_score: number;
  has_clean_retest: boolean;
  closed_beyond_level: boolean;
}

function computeRollingVolMean(bars: Bar[], period = 20): number[] {
  const result: number[] = new Array(bars.length).fill(0);
  for (let i = 0; i < bars.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - period + 1); j <= i; j++) { sum += bars[j].v; cnt++; }
    result[i] = cnt > 0 ? sum / cnt : bars[i].v;
  }
  return result;
}

function bktScoreBreakStrength(
  close: number, brokenLevel: number, dir: string, atr: number,
): { score: number; closedBeyond: boolean } {
  if (atr <= 0) return { score: 0, closedBeyond: false };
  const delta = dir === "UP" ? (close - brokenLevel) : (brokenLevel - close);
  const dAtr = delta / atr;
  const closedBeyond = dAtr > 0;
  let score: number;
  if (dAtr <= 0) score = 0;
  else if (dAtr >= BKT_STRONG_CLOSE_ATR) score = 100;
  else {
    const x = (dAtr - BKT_MIN_CLOSE_BEYOND_ATR) / (BKT_STRONG_CLOSE_ATR - BKT_MIN_CLOSE_BEYOND_ATR);
    score = Math.max(0, Math.min(x, 1)) * 100;
  }
  return { score, closedBeyond };
}

function bktScoreRetest(
  bars: Bar[], fromIdx: number, brokenLevel: number, dir: string, atr: number,
): { score: number; hasCleanRetest: boolean } {
  if (atr <= 0) return { score: 50, hasCleanRetest: false };
  const tolerance = BKT_MAX_RETEST_ATR * atr;
  let hasCleanRetest = false;
  let failedRetest = false;

  for (let i = fromIdx + 1; i <= fromIdx + BKT_LOOKAHEAD && i < bars.length; i++) {
    const b = bars[i];
    if (dir === "UP") {
      const dist = brokenLevel - b.l;
      if (dist >= 0 && dist <= tolerance) {
        if (b.c >= brokenLevel) hasCleanRetest = true;
        else { failedRetest = true; break; }
      }
    } else {
      const dist = b.h - brokenLevel;
      if (dist >= 0 && dist <= tolerance) {
        if (b.c <= brokenLevel) hasCleanRetest = true;
        else { failedRetest = true; break; }
      }
    }
  }

  if (hasCleanRetest && !failedRetest) return { score: 85, hasCleanRetest: true };
  if (failedRetest) return { score: 10, hasCleanRetest: false };
  return { score: 50, hasCleanRetest: false };
}

function bktScoreVolume(
  vol: number, volSma: number, volumeState: string, dir: string,
): number {
  const relVol = volSma > 0 ? vol / volSma : 0;
  let score: number;
  if (relVol >= BKT_STRONG_VOL_RELATIVE) score = 100;
  else if (relVol >= BKT_MIN_VOL_RELATIVE) {
    const x = (relVol - BKT_MIN_VOL_RELATIVE) / (BKT_STRONG_VOL_RELATIVE - BKT_MIN_VOL_RELATIVE);
    score = Math.max(0, Math.min(x, 1)) * 100;
  } else score = 20;

  if      (dir === "UP"   && volumeState === "REJECTING_ABOVE") score = Math.min(score, 20);
  else if (dir === "DOWN" && volumeState === "REJECTING_BELOW") score = Math.min(score, 20);
  else if (dir === "UP"   && volumeState === "ACCEPTING_ABOVE") score = Math.min(score * 1.1, 100);
  else if (dir === "DOWN" && volumeState === "ACCEPTING_BELOW") score = Math.min(score * 1.1, 100);

  return score;
}

function bktScoreEnvironment(
  mtfScore: number, liqDir: string, liqMag: number, regime: string, dir: string,
): number {
  let score = mtfScore;
  const mag = liqMag / 100;
  const liqMatch = (dir === "UP" && liqDir === "ABOVE") || (dir === "DOWN" && liqDir === "BELOW");
  const liqContra = (dir === "UP" && liqDir === "BELOW") || (dir === "DOWN" && liqDir === "ABOVE");
  if (liqMatch)  score = Math.min(score * (1 + 0.2 * mag), 100);
  if (liqContra) score = score * (1 - 0.2 * mag);
  if (regime === "RANGE") score *= 0.75;
  return Math.min(Math.max(score, 0), 100);
}

function evaluateBreakout(
  bars: Bar[],
  barIdx: number,
  brokenLevel: number,
  mssDirection: string,
  volMeans: number[],
  volumeState: string,
  mtfScore: number,
  liqDir: string,
  liqMag: number,
  regime: string,
  rollingAtr: number[],
): BreakoutResult {
  const dir = mssDirection === "BULL" ? "UP" : "DOWN";
  const bar = bars[barIdx];
  const atr = rollingAtr[barIdx] ?? 0;
  const volSma = volMeans[barIdx] ?? bar.v;

  const { score: bsScore, closedBeyond } = bktScoreBreakStrength(bar.c, brokenLevel, dir, atr);
  const { score: rtScore, hasCleanRetest } = bktScoreRetest(bars, barIdx, brokenLevel, dir, atr);
  const vcScore  = bktScoreVolume(bar.v, volSma, volumeState, dir);
  const envScore = bktScoreEnvironment(mtfScore, liqDir, liqMag, regime, dir);

  const quality = Math.round(Math.min(Math.max(
    bsScore  * BKT_W_BREAK_STRENGTH +
    rtScore  * BKT_W_RETEST +
    vcScore  * BKT_W_VOLUME +
    envScore * BKT_W_ENV,
    0), 100) * 100) / 100;

  let btype: BreakoutType;
  if (quality >= BKT_CONTINUATION_THRESH) btype = "CONTINUATION";
  else if (quality <= BKT_FAKEOUT_THRESH)  btype = "FAKEOUT";
  else btype = "UNCLEAR";

  return {
    breakout_quality_score:      quality,
    breakout_type:               btype,
    break_strength_score:        Math.round(bsScore  * 100) / 100,
    retest_quality_score:        Math.round(rtScore  * 100) / 100,
    volume_confirmation_score:   Math.round(vcScore  * 100) / 100,
    environment_alignment_score: Math.round(envScore * 100) / 100,
    has_clean_retest:            hasCleanRetest,
    closed_beyond_level:         closedBeyond,
  };
}

// ── Confluence Engine helpers ─────────────────────────────────────────
const CONF_W_TREND    = 0.20;
const CONF_W_REGIME   = 0.10;
const CONF_W_VOL      = 0.10;
const CONF_W_VOLUME   = 0.10;
const CONF_W_LIQ      = 0.15;
const CONF_W_MTF      = 0.15;
const CONF_W_MSS      = 0.10;
const CONF_W_BREAKOUT = 0.10;
const _CONF_NO_TRADE  = 40; // eslint-disable-line @typescript-eslint/no-unused-vars
const CONF_MEDIUM     = 60;
const CONF_HIGH       = 75;
const CONF_A_PLUS     = 85;
const CONF_MIN_BIAS   = 55;
const CONF_DRAW_BONUS = 10;
const CONF_TREND_BONUS = 10;

type SetupGrade = "NO_TRADE" | "MEDIUM_SETUP" | "HIGH_SETUP" | "A_PLUS_SETUP";
type TradeBias  = "LONG" | "SHORT" | "NEUTRAL";

interface ConfluenceComponents {
  trend: number; regime: number; volatility: number; volume: number;
  liquidity: number; mtf: number; mss: number; breakout: number;
}

interface ConfluenceResult {
  confluence_score: number;
  setup_grade: SetupGrade;
  trade_bias: TradeBias;
  confluence_components: ConfluenceComponents;
}

function confTrend(score: number, dir: string): number {
  return dir === "NEUTRAL" ? score * 0.5 : score;
}
function confRegime(regime: string): number {
  return regime === "TREND" ? 80 : regime === "TRANSITION" ? 60 : 30;
}
function confVolatility(vol: string): number {
  return vol === "MEDIUM" ? 80 : vol === "LOW" ? 60 : 40;
}
function confVolume(vs: string): number {
  return (vs === "ACCEPTING_ABOVE" || vs === "ACCEPTING_BELOW") ? 80 : vs === "IN_VALUE" ? 60 : 20;
}
function confLiquidity(mag: number, liqDir: string, evtDir: string | null): number {
  let s = mag;
  if (evtDir !== null) {
    const up = evtDir === "UP" || evtDir === "BULL";
    if ((up && liqDir === "ABOVE") || (!up && liqDir === "BELOW")) s = Math.min(s * 1.1, 100);
    else if ((up && liqDir === "BELOW") || (!up && liqDir === "ABOVE")) s = s * 0.8;
  }
  return Math.min(Math.max(s, 0), 100);
}
function confMTF(mtfScore: number, mtfState: string, evtDir: string | null): number {
  let s = mtfScore;
  if (evtDir !== null) {
    const up = evtDir === "UP" || evtDir === "BULL";
    if ((up && mtfState.includes("UP")) || (!up && mtfState.includes("DOWN"))) s = Math.min(s * 1.1, 100);
    else if ((up && mtfState.includes("DOWN")) || (!up && mtfState.includes("UP"))) s = s * 0.8;
  }
  return Math.min(Math.max(s, 0), 100);
}
function confMSS(dispQuality: number | null): number {
  if (dispQuality === null) return 50;
  // displacement_quality is 0-1 scale → convert to 0-100
  return dispQuality <= 1.0 ? dispQuality * 100 : dispQuality;
}
function confBreakout(bktScore: number | null, bktType: string | null): number {
  if (bktScore === null) return 50;
  return bktType === "FAKEOUT" ? Math.min(bktScore, 20) : bktScore;
}
function confGrade(score: number): SetupGrade {
  if (score >= CONF_A_PLUS)  return "A_PLUS_SETUP";
  if (score >= CONF_HIGH)    return "HIGH_SETUP";
  if (score >= CONF_MEDIUM)  return "MEDIUM_SETUP";
  return "NO_TRADE";
}
function confBias(evtDir: string | null, trendDir: string, mtfState: string, liqDir: string): TradeBias {
  let long = 0, short = 0;
  if (evtDir !== null) {
    if (evtDir === "UP" || evtDir === "BULL") long += 30; else short += 30;
  }
  if (trendDir === "UP")   long  += CONF_TREND_BONUS;
  else if (trendDir === "DOWN") short += CONF_TREND_BONUS;
  if (mtfState.includes("UP"))   long  += 20;
  if (mtfState.includes("DOWN")) short += 20;
  if (liqDir === "ABOVE")  long  += CONF_DRAW_BONUS;
  else if (liqDir === "BELOW")  short += CONF_DRAW_BONUS;
  if (long  >= CONF_MIN_BIAS && long  > short) return "LONG";
  if (short >= CONF_MIN_BIAS && short > long)  return "SHORT";
  return "NEUTRAL";
}
function computeConfluenceResult(
  trendScore: number, trendDir: string,
  regime: string, volState: string, volumeState: string,
  liqMag: number, liqDir: string,
  mtfScore: number, mtfState: string,
  dispQuality: number | null,
  bktScore: number | null, bktType: string | null,
  evtDir: string | null,
): ConfluenceResult {
  const c: ConfluenceComponents = {
    trend:      Math.round(confTrend(trendScore, trendDir)),
    regime:     Math.round(confRegime(regime)),
    volatility: Math.round(confVolatility(volState)),
    volume:     Math.round(confVolume(volumeState)),
    liquidity:  Math.round(confLiquidity(liqMag, liqDir, evtDir)),
    mtf:        Math.round(confMTF(mtfScore, mtfState, evtDir)),
    mss:        Math.round(confMSS(dispQuality)),
    breakout:   Math.round(confBreakout(bktScore, bktType)),
  };
  const raw = c.trend * CONF_W_TREND + c.regime * CONF_W_REGIME + c.volatility * CONF_W_VOL +
              c.volume * CONF_W_VOLUME + c.liquidity * CONF_W_LIQ + c.mtf * CONF_W_MTF +
              c.mss * CONF_W_MSS + c.breakout * CONF_W_BREAKOUT;
  const score = Math.round(Math.min(Math.max(raw, 0), 100) * 100) / 100;
  return {
    confluence_score: score,
    setup_grade: confGrade(score),
    trade_bias:  confBias(evtDir, trendDir, mtfState, liqDir),
    confluence_components: c,
  };
}

// ── Context Formatter ─────────────────────────────────────────────────────────
const CTX_TREND_WEAK = 40, CTX_TREND_MOD = 70;
const CTX_LIQ_WEAK = 40, CTX_LIQ_STRONG = 70;
const CTX_MTF_WEAK = 40, CTX_MTF_STRONG = 70;
const CTX_BKT_WEAK = 40, CTX_BKT_STRONG = 70;
const CTX_CONF_WEAK = 40, CTX_CONF_STRONG = 70;
const CTX_RVOL_LOW = 0.8, CTX_RVOL_HIGH = 1.2, CTX_RVOL_EXTREME = 2.0;
const CTX_SESSION_NEAR_ATR = 0.5;
const CTX_STRONG_BIAS = 3;
const CTX_MAX_FLAGS = 8;
const CTX_SUMMARY_MAX = 220;

interface CtxSnap {
  regime: string | null | undefined;
  trend_direction: string | null | undefined;
  trend_strength_score: number | null | undefined;
  volatility_state: string | null | undefined;
  liquidity_draw_direction: string | null | undefined;
  liquidity_magnet_score: number | null | undefined;
  dist_session_high: number | null | undefined;
  dist_session_low: number | null | undefined;
  mtf_alignment_state: string | null | undefined;
  mtf_alignment_score: number | null | undefined;
  volume_state: string | null | undefined;
  participation_state: string | null | undefined;
  rvol_ratio: number | null | undefined;
  volume_spike_flag: boolean | null | undefined;
  breakout_type: string | null | undefined;
  breakout_quality_score: number | null | undefined;
  confluence_score: number | null | undefined;
  setup_grade: string | null | undefined;
  bar_trade_bias: string | null | undefined;
  session: string | null | undefined;
}

interface CtxEvent {
  direction?: string | null;
  entry_bias?: string | null;
  event_confluence_score?: number | null;
  event_grade?: string | null;
}

function ctxGet<T>(val: T | null | undefined): T | null {
  if (val === null || val === undefined) return null;
  if (typeof val === "number" && isNaN(val)) return null;
  return val;
}

function ctxTrendFlags(s: CtxSnap): string[] {
  const regime = ctxGet(s.regime);
  const dir = ctxGet(s.trend_direction);
  const score = ctxGet(s.trend_strength_score) ?? 0;
  if (regime === "TREND" && dir === "UP" && score >= CTX_TREND_MOD) return ["TRENDING UP"];
  if (regime === "TREND" && dir === "DOWN" && score >= CTX_TREND_MOD) return ["TRENDING DOWN"];
  if (regime === "RANGE") return ["RANGE-BOUND"];
  if (score < CTX_TREND_WEAK && regime !== "TREND" && regime !== "RANGE") return ["WEAK TREND"];
  if (regime === "TRANSITION" || regime === null) {
    if (dir === "UP") return ["MILD UP BIAS"];
    if (dir === "DOWN") return ["MILD DOWN BIAS"];
  }
  return [];
}

function ctxVolatilityFlags(s: CtxSnap): string[] {
  const state = ctxGet(s.volatility_state);
  if (state === "LOW") return ["LOW VOLATILITY"];
  if (state === "HIGH") return ["HIGH VOLATILITY"];
  return [];
}

function ctxLiquidityFlags(s: CtxSnap): string[] {
  const dir = ctxGet(s.liquidity_draw_direction);
  const score = ctxGet(s.liquidity_magnet_score) ?? 0;
  const distSH = ctxGet(s.dist_session_high);
  const distSL = ctxGet(s.dist_session_low);

  if (distSH !== null && distSH >= 0 && distSH < CTX_SESSION_NEAR_ATR && dir === "ABOVE")
    return ["NEAR SESSION HIGH"];
  if (distSL !== null && Math.abs(distSL) < CTX_SESSION_NEAR_ATR && dir === "BELOW")
    return ["NEAR SESSION LOW"];

  if (dir === "ABOVE") {
    if (score >= CTX_LIQ_STRONG) return ["LIQUIDITY PULL ABOVE"];
    if (score >= CTX_LIQ_WEAK)   return ["MILD LIQUIDITY PULL ABOVE"];
  } else if (dir === "BELOW") {
    if (score >= CTX_LIQ_STRONG) return ["LIQUIDITY PULL BELOW"];
    if (score >= CTX_LIQ_WEAK)   return ["MILD LIQUIDITY PULL BELOW"];
  }
  return [];
}

function ctxMTFFlags(s: CtxSnap): string[] {
  const state = ctxGet(s.mtf_alignment_state) ?? "";
  const score = ctxGet(s.mtf_alignment_score) ?? 0;
  if (state === "FULL_ALIGN_UP" || (state === "PARTIAL_ALIGN_UP" && score >= CTX_MTF_STRONG))
    return ["MTF ALIGN UP"];
  if (state === "FULL_ALIGN_DOWN" || (state === "PARTIAL_ALIGN_DOWN" && score >= CTX_MTF_STRONG))
    return ["MTF ALIGN DOWN"];
  if ((state === "PARTIAL_ALIGN_UP" || state === "PARTIAL_ALIGN_DOWN") && score >= CTX_MTF_WEAK)
    return ["PARTIAL MTF ALIGNMENT"];
  if (state === "CONFLICT") return ["MIXED MTF CONTEXT"];
  return [];
}

function ctxParticipationFlags(s: CtxSnap): string[] {
  const state = ctxGet(s.participation_state);
  const rvol = ctxGet(s.rvol_ratio) ?? 1.0;
  const volState = ctxGet(s.volume_state);
  const flags: string[] = [];

  if (state === "EXTREME" || rvol >= CTX_RVOL_EXTREME) flags.push("AGGRESSIVE PARTICIPATION");
  else if (state === "ELEVATED" || rvol >= CTX_RVOL_HIGH) flags.push("ELEVATED PARTICIPATION");
  else if (state === "LOW_ACTIVITY" || rvol <= CTX_RVOL_LOW) flags.push("QUIET TAPE");

  if (volState === "ACCEPTING_ABOVE") flags.push("PRICE ACCEPTING ABOVE VALUE");
  else if (volState === "ACCEPTING_BELOW") flags.push("PRICE ACCEPTING BELOW VALUE");

  return flags;
}

function ctxBreakoutFlags(s: CtxSnap): string[] {
  const btype = ctxGet(s.breakout_type);
  const score = ctxGet(s.breakout_quality_score) ?? 0;
  if (btype === "CONTINUATION") {
    if (score >= CTX_BKT_STRONG) return ["BREAKOUT CONTINUATION"];
    if (score >= CTX_BKT_WEAK)   return ["POTENTIAL BREAKOUT CONTINUATION"];
  } else if (btype === "FAKEOUT") {
    if (score > CTX_BKT_WEAK) return ["FAKEOUT WARNING"];
  } else if (btype === "UNCLEAR") {
    if (score >= CTX_BKT_WEAK) return ["POTENTIAL BREAKOUT"];
  }
  return [];
}

function ctxConfluenceFlags(s: CtxSnap, e: CtxEvent): string[] {
  const grade = ctxGet(e.event_grade) ?? ctxGet(s.setup_grade);
  const score = ctxGet(e.event_confluence_score) ?? ctxGet(s.confluence_score) ?? 0;
  if (grade === "A_PLUS_SETUP") return ["A+ CONTEXT"];
  if (grade === "HIGH_SETUP")   return ["A CONTEXT"];
  if (grade === "MEDIUM_SETUP") return ["B CONTEXT"];
  if (score >= CTX_CONF_STRONG) return ["HIGH CONFLUENCE"];
  if (score >= CTX_CONF_WEAK)   return ["MODERATE CONFLUENCE"];
  return [];
}

function ctxBiasFlags(s: CtxSnap, e: CtxEvent): string[] {
  const dir = ctxGet(e.direction) ?? ctxGet(e.entry_bias) ?? ctxGet(s.bar_trade_bias);
  if (!dir) return [];
  const isLong  = ["BULL", "LONG", "UP"].includes(dir);
  const isShort = ["BEAR", "SHORT", "DOWN"].includes(dir);
  if (!isLong && !isShort) return [];

  const trendDir = ctxGet(s.trend_direction) ?? "";
  const mtfState = ctxGet(s.mtf_alignment_state) ?? "";
  const liqDir   = ctxGet(s.liquidity_draw_direction) ?? "";

  let factors = 0;
  if (isLong) {
    if (trendDir === "UP")     factors++;
    if (mtfState.includes("UP"))   factors++;
    if (liqDir === "ABOVE")    factors++;
  } else {
    if (trendDir === "DOWN")   factors++;
    if (mtfState.includes("DOWN")) factors++;
    if (liqDir === "BELOW")    factors++;
  }

  if (factors >= CTX_STRONG_BIAS) return [isLong ? "STRONG LONG BIAS" : "STRONG SHORT BIAS"];
  if (factors >= 1) return [isLong ? "LONG BIAS" : "SHORT BIAS"];
  return [];
}

function ctxSessionFlags(s: CtxSnap): string[] {
  const sess = ctxGet(s.session);
  if (sess === "ASIA")   return ["ASIA SESSION"];
  if (sess === "LONDON") return ["LONDON SESSION"];
  if (sess === "NY")     return ["NEW YORK SESSION"];
  return [];
}

function buildContextFlags(snap: CtxSnap, evt: CtxEvent | null): string[] {
  const e = evt ?? {};
  const raw = [
    ...ctxTrendFlags(snap),
    ...ctxVolatilityFlags(snap),
    ...ctxLiquidityFlags(snap),
    ...ctxMTFFlags(snap),
    ...ctxParticipationFlags(snap),
    ...ctxBreakoutFlags(snap),
    ...ctxConfluenceFlags(snap, e),
    ...ctxBiasFlags(snap, e),
    ...ctxSessionFlags(snap),
  ];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const f of raw) {
    if (!seen.has(f)) { seen.add(f); result.push(f); }
  }
  return result.slice(0, CTX_MAX_FLAGS);
}

function ctxSummaryTrendVol(s: CtxSnap): string | null {
  const regime = ctxGet(s.regime);
  const dir    = ctxGet(s.trend_direction);
  const score  = ctxGet(s.trend_strength_score) ?? 0;
  const vol    = ctxGet(s.volatility_state);

  let trendPhrase: string;
  if (regime === "RANGE") trendPhrase = "range-bound conditions";
  else if (regime === "TREND" && dir === "UP")
    trendPhrase = score >= CTX_TREND_MOD ? "strong uptrend" : "uptrend";
  else if (regime === "TREND" && dir === "DOWN")
    trendPhrase = score >= CTX_TREND_MOD ? "strong downtrend" : "downtrend";
  else if (dir === "UP") trendPhrase = "mild upward bias";
  else if (dir === "DOWN") trendPhrase = "mild downward bias";
  else trendPhrase = "weak trend";

  const volMap: Record<string, string> = {
    LOW: "low volatility", MEDIUM: "normal volatility", HIGH: "high volatility",
  };
  const volPhrase = vol ? volMap[vol] : "";
  return volPhrase ? `${trendPhrase} with ${volPhrase}` : trendPhrase;
}

function ctxSummaryLiqMTF(s: CtxSnap): string | null {
  const dir    = ctxGet(s.liquidity_draw_direction);
  const score  = ctxGet(s.liquidity_magnet_score) ?? 0;
  const distSH = ctxGet(s.dist_session_high);
  const distSL = ctxGet(s.dist_session_low);
  const mtfSt  = ctxGet(s.mtf_alignment_state) ?? "";
  const mtfSc  = ctxGet(s.mtf_alignment_score) ?? 0;

  let liqPhrase: string | null = null;
  if (distSH !== null && distSH >= 0 && distSH < CTX_SESSION_NEAR_ATR && dir === "ABOVE")
    liqPhrase = "near session high";
  else if (distSL !== null && Math.abs(distSL) < CTX_SESSION_NEAR_ATR && dir === "BELOW")
    liqPhrase = "near session low";
  else if (dir === "ABOVE")
    liqPhrase = score >= CTX_LIQ_STRONG ? "liquidity drawing above" : "mild liquidity pull above";
  else if (dir === "BELOW")
    liqPhrase = score >= CTX_LIQ_STRONG ? "liquidity drawing below" : "mild liquidity pull below";
  else liqPhrase = "balanced liquidity";

  let mtfPhrase: string | null = null;
  if (mtfSt === "FULL_ALIGN_UP" || (mtfSt.includes("UP") && mtfSc >= CTX_MTF_STRONG))
    mtfPhrase = "multi-timeframe alignment up";
  else if (mtfSt === "FULL_ALIGN_DOWN" || (mtfSt.includes("DOWN") && mtfSc >= CTX_MTF_STRONG))
    mtfPhrase = "bearish multi-timeframe alignment";
  else if (mtfSt.includes("PARTIAL"))
    mtfPhrase = "partial multi-timeframe alignment";
  else if (mtfSt === "CONFLICT")
    mtfPhrase = "mixed multi-timeframe context";

  if (liqPhrase && mtfPhrase) return `${liqPhrase} and ${mtfPhrase}`;
  return liqPhrase ?? mtfPhrase;
}

function ctxSummaryParticipation(s: CtxSnap): string | null {
  const state = ctxGet(s.participation_state);
  const rvol  = ctxGet(s.rvol_ratio) ?? 1.0;
  const spike = ctxGet(s.volume_spike_flag);
  if (state === "EXTREME" || rvol >= CTX_RVOL_EXTREME)
    return spike ? "aggressive participation with volume spike" : "aggressive participation and above-average volume";
  if (state === "ELEVATED" || rvol >= CTX_RVOL_HIGH)
    return "elevated participation and above-average volume";
  if (state === "LOW_ACTIVITY" || rvol <= CTX_RVOL_LOW)
    return "muted participation and below-average volume";
  return null;
}

function ctxSummarySetup(s: CtxSnap, e: CtxEvent | null): string | null {
  const ee     = e ?? {};
  const grade  = ctxGet(ee.event_grade) ?? ctxGet(s.setup_grade);
  const score  = ctxGet(ee.event_confluence_score) ?? ctxGet(s.confluence_score) ?? 0;
  const dir    = ctxGet(ee.direction) ?? ctxGet(s.bar_trade_bias) ?? "";
  const isLong  = ["BULL", "LONG", "UP"].includes(dir);
  const isShort = ["BEAR", "SHORT", "DOWN"].includes(dir);
  const bias = isLong ? "long" : isShort ? "short" : "";

  if (grade === "A_PLUS_SETUP")
    return `A+ ${bias ? bias + " " : ""}context with high confluence and clear continuation bias`;
  if (grade === "HIGH_SETUP")
    return `A-grade ${bias ? bias + " " : ""}opportunity with strong confluence`;
  if (grade === "MEDIUM_SETUP")
    return "B-grade setup in a mixed environment";
  if (score < CTX_CONF_WEAK)
    return "low-confluence environment — no clear setup";
  return null;
}

function buildEnvironmentSummary(snap: CtxSnap, evt: CtxEvent | null): string {
  const c1 = ctxSummaryTrendVol(snap);
  const c2 = ctxSummaryLiqMTF(snap);
  const c3 = ctxSummaryParticipation(snap);
  const c4 = ctxSummarySetup(snap, evt);
  const parts = [c1, c2, c3, c4].filter(Boolean) as string[];
  let sentence = parts.join(", ");
  if (sentence) sentence = sentence[0].toUpperCase() + sentence.slice(1);
  if (sentence.length > CTX_SUMMARY_MAX)
    sentence = sentence.slice(0, CTX_SUMMARY_MAX - 3).replace(/,\s*$/, "") + "...";
  return sentence;
}

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol") || "NAS100_USD";
    const now = new Date();

    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));

    let dataDay = todayStart;
    let dataBars: Bar[] = [];

    // Walk back up to 5 days to find a trading day
    for (let offset = 0; offset < 5; offset++) {
      const d = new Date(todayStart.getTime() - offset * 86400000);
      const dEnd = new Date(d.getTime() + 86400000);
      const bars = await fetchBars(symbol, d.toISOString(), dEnd.toISOString());
      if (bars.length > 0) {
        dataDay = d;
        dataBars = bars;
        break;
      }
    }

    if (dataBars.length === 0) {
      return NextResponse.json({
        symbol, date: todayStart.toISOString().slice(0, 10),
        total_mss: 0, accepted: 0, rejected: 0,
        avg_displacement_quality: 0, events: [],
      });
    }

    const dateStr = dataDay.toISOString().slice(0, 10);

    // PDH/PDL — previous trading day
    let prevBars: Bar[] = [];
    for (let offset = 1; offset < 5; offset++) {
      const d = new Date(dataDay.getTime() - offset * 86400000);
      const dEnd = new Date(d.getTime() + 86400000);
      prevBars = await fetchBars(symbol, d.toISOString(), dEnd.toISOString());
      if (prevBars.length > 0) break;
    }
    const daily = computeDailyExtremes(prevBars);

    // Pipeline
    const atr = computeATR(dataBars);
    const cps = identifyControlPoints(dataBars);
    const regimeSeries = computeRegimeSeries(dataBars, DEFAULT_REGIME_CONFIG);
    const regimeForMSS = regimeSeries.map((r) => ({ time: r.time, regime: r.regime }));
    const volStates = classifyVolatilitySeries(dataBars);
    const volMap = new Map<string, string>();
    for (let i = 0; i < dataBars.length; i++) volMap.set(dataBars[i].t, volStates[i]);
    const trendSeries = computeTrendSeries(dataBars);
    const trendMap = new Map<string, TrendPoint>();
    for (const tp of trendSeries) trendMap.set(tp.time, tp);

    // Volume series
    const volumeSeries = computeVolumeSeries(dataBars);
    const volumeMap = new Map<string, VolumePoint>();
    for (const vp of volumeSeries) volumeMap.set(vp.time, vp);

    // Liquidity draw series
    const rollingAtr14 = computeRollingATR(dataBars, VOL_ATR_PERIOD);
    const { sessionHighs, sessionLows } = computeSessionHighsLows(dataBars);
    const liquidityDrawSeries = computeLiquidityDrawSeries(
      dataBars, cps, daily.pdh, daily.pdl, volumeSeries, rollingAtr14, sessionHighs, sessionLows
    );

    // Per-bar session context map (for event tagging + response header)
    const sessionCtxMap = new Map<string, { sh: number; sl: number; distSH: number | null; distSL: number | null }>();
    for (let i = 0; i < dataBars.length; i++) {
      const b = dataBars[i];
      const atr = rollingAtr14[i];
      const sh = sessionHighs[i];
      const sl = sessionLows[i];
      const distSH = (atr && atr > 0 && isFinite(sh)) ? (sh - b.c) / atr : null;
      const distSL = (atr && atr > 0 && isFinite(sl)) ? (sl - b.c) / atr : null;
      sessionCtxMap.set(b.t, { sh, sl, distSH, distSL });
    }
    const liqDrawMap = new Map<string, LiquidityDrawPoint>();
    for (const ld of liquidityDrawSeries) liqDrawMap.set(ld.time, ld);

    // MTF alignment + RVOL history — fetch in parallel
    const tfEnd        = new Date(dataDay.getTime() + 86400000).toISOString();
    const htfStart     = new Date(dataDay.getTime() - 30 * 86400000).toISOString();
    const mtfStart     = new Date(dataDay.getTime() - 14 * 86400000).toISOString();
    const rvolHistStart = new Date(dataDay.getTime() - RVOL_LOOKBACK_DAYS * 86400000).toISOString();
    const [htfBars, mtfBarsRaw, rvolHistBars] = await Promise.all([
      fetchBars(symbol, htfStart, tfEnd, "1Hour"),
      fetchBars(symbol, mtfStart, tfEnd, "15Min"),
      fetchBars(symbol, rvolHistStart, dataDay.toISOString()),
    ]);
    const htfTrend  = computeTrendSeries(htfBars);
    const htfRegime = computeRegimeSeries(htfBars, DEFAULT_REGIME_CONFIG);
    const htfIndex  = buildTimeIndex(htfTrend, htfRegime);
    const mtfTrend  = computeTrendSeries(mtfBarsRaw);
    const mtfIndex  = buildTimeIndex(mtfTrend);
    const mtfAlignSeries = computeMTFAlignmentSeries(dataBars, trendSeries, mtfIndex, htfIndex);
    const mtfAlignMap = new Map<string, MTFAlignPoint>();
    for (const ma of mtfAlignSeries) mtfAlignMap.set(ma.time, ma);

    // Participation / RVOL series
    const participationSeries = computeParticipationSeries(dataBars, rvolHistBars);
    const participationMap = new Map<string, ParticipationPoint>();
    for (const p of participationSeries) participationMap.set(p.time, p);

    // Breakout quality — pre-compute vol means + bar index map
    const volMeans = computeRollingVolMean(dataBars, 20);
    const barIndexMap = new Map<string, number>();
    for (let i = 0; i < dataBars.length; i++) barIndexMap.set(dataBars[i].t, i);

    // Bar-level confluence series (used for ctxSnapMap + distribution)
    const confSeries: ConfluenceResult[] = dataBars.map((_, i) => {
      const tp = trendSeries[i];
      const vp = volumeSeries[i];
      const ld = liquidityDrawSeries[i];
      const ma = mtfAlignSeries[i];
      const rg = regimeSeries[i];
      return computeConfluenceResult(
        tp?.score ?? 0,
        tp?.direction ?? "NEUTRAL",
        rg?.regime ?? "TRANSITION",
        volStates[i] ?? "MEDIUM",
        vp?.state ?? "IN_VALUE",
        ld?.magnet_score ?? 0,
        ld?.direction ?? "NEUTRAL",
        ma?.mtf_alignment_score ?? 0,
        ma?.mtf_alignment_state ?? "WEAK_ALIGN",
        null, null, null, null,
      );
    });

    // Build per-bar context snap map for the context formatter
    const ctxSnapMap = new Map<string, CtxSnap>();
    for (let i = 0; i < dataBars.length; i++) {
      const b = dataBars[i];
      const sc = sessionCtxMap.get(b.t);
      ctxSnapMap.set(b.t, {
        regime:                   regimeSeries[i]?.regime ?? null,
        trend_direction:          trendSeries[i]?.direction ?? null,
        trend_strength_score:     trendSeries[i]?.score ?? null,
        volatility_state:         volStates[i] ?? null,
        liquidity_draw_direction: liquidityDrawSeries[i]?.direction ?? null,
        liquidity_magnet_score:   liquidityDrawSeries[i]?.magnet_score ?? null,
        dist_session_high:        sc?.distSH ?? null,
        dist_session_low:         sc?.distSL ?? null,
        mtf_alignment_state:      mtfAlignSeries[i]?.mtf_alignment_state ?? null,
        mtf_alignment_score:      mtfAlignSeries[i]?.mtf_alignment_score ?? null,
        volume_state:             volumeSeries[i]?.state ?? null,
        participation_state:      participationSeries[i]?.participation_state ?? null,
        rvol_ratio:               participationSeries[i]?.rvol_ratio ?? null,
        volume_spike_flag:        participationSeries[i]?.volume_spike_flag ?? null,
        breakout_type:            null,
        breakout_quality_score:   null,
        confluence_score:         confSeries[i]?.confluence_score ?? null,
        setup_grade:              confSeries[i]?.setup_grade ?? null,
        bar_trade_bias:           confSeries[i]?.trade_bias ?? null,
        session:                  getBarSession(b.t),
      });
    }

    // Current bar environment summary
    const lastCtxSnap = dataBars.length > 0
      ? ctxSnapMap.get(dataBars[dataBars.length - 1].t) ?? null
      : null;
    const currentEnvSummary = lastCtxSnap ? buildEnvironmentSummary(lastCtxSnap, null) : "";

    const events = detectMSS(dataBars, cps, atr, daily.pdh, daily.pdl, regimeForMSS);
    // Tag each event with volatility_state, trend, volume context, and liquidity draw
    for (const evt of events) {
      evt.volatility_state = volMap.get(evt.timestamp) ?? "MEDIUM";
      const tp = trendMap.get(evt.timestamp);
      evt.trend_strength_score = tp?.score ?? 0;
      evt.trend_direction = tp?.direction ?? "NEUTRAL";
      const vp = volumeMap.get(evt.timestamp);
      evt.volume_state = vp?.state ?? null;
      evt.vwap = vp ? Math.round(vp.vwap * 10000) / 10000 : null;
      evt.poc = vp ? Math.round(vp.poc * 10000) / 10000 : null;
      evt.vah = vp ? Math.round(vp.vah * 10000) / 10000 : null;
      evt.val = vp ? Math.round(vp.val * 10000) / 10000 : null;
      const ld = liqDrawMap.get(evt.timestamp);
      evt.liquidity_draw_direction = ld?.direction ?? null;
      evt.liquidity_magnet_score   = ld?.magnet_score ?? null;
      const ma = mtfAlignMap.get(evt.timestamp);
      evt.htf_bias             = ma?.htf_bias ?? "RANGE";
      evt.mtf_structure_bias   = ma?.mtf_structure_bias ?? "NEUTRAL";
      evt.ltf_direction        = ma?.ltf_direction ?? "NEUTRAL";
      evt.mtf_alignment_state  = ma?.mtf_alignment_state ?? "WEAK_ALIGN";
      evt.mtf_alignment_score  = ma?.mtf_alignment_score ?? 0;

      // Breakout quality evaluation
      const barIdx = barIndexMap.get(evt.timestamp) ?? -1;
      if (barIdx >= 0) {
        const bkt = evaluateBreakout(
          dataBars, barIdx,
          evt.control_point_price,
          evt.direction,
          volMeans,
          evt.volume_state ?? "IN_VALUE",
          evt.mtf_alignment_score ?? 0,
          evt.liquidity_draw_direction ?? "NEUTRAL",
          evt.liquidity_magnet_score ?? 0,
          evt.regime ?? "TRANSITION",
          rollingAtr14,
        );
        evt.breakout_quality_score      = bkt.breakout_quality_score;
        evt.breakout_type               = bkt.breakout_type;
        evt.break_strength_score        = bkt.break_strength_score;
        evt.retest_quality_score        = bkt.retest_quality_score;
        evt.volume_confirmation_score   = bkt.volume_confirmation_score;
        evt.environment_alignment_score = bkt.environment_alignment_score;
        evt.has_clean_retest            = bkt.has_clean_retest;
        evt.closed_beyond_level         = bkt.closed_beyond_level;
      }

      // Confluence score
      const conf = computeConfluenceResult(
        evt.trend_strength_score ?? 0,
        evt.trend_direction ?? "NEUTRAL",
        evt.regime ?? "TRANSITION",
        evt.volatility_state ?? "MEDIUM",
        evt.volume_state ?? "IN_VALUE",
        evt.liquidity_magnet_score ?? 0,
        evt.liquidity_draw_direction ?? "NEUTRAL",
        evt.mtf_alignment_score ?? 0,
        evt.mtf_alignment_state ?? "WEAK_ALIGN",
        evt.displacement_quality,
        evt.breakout_quality_score ?? null,
        evt.breakout_type ?? null,
        evt.direction,
      );
      evt.confluence_score      = conf.confluence_score;
      evt.setup_grade           = conf.setup_grade;
      evt.event_trade_bias      = conf.trade_bias;
      evt.confluence_components = conf.confluence_components;

      // Participation / RVOL tagging
      const pp = participationMap.get(evt.timestamp);
      evt.rvol_ratio          = pp?.rvol_ratio ?? null;
      evt.participation_state = pp?.participation_state ?? null;
      evt.volume_spike_flag   = pp?.volume_spike_flag ?? null;

      // Session high/low tagging
      const sc = sessionCtxMap.get(evt.timestamp);
      evt.session_high      = sc ? Math.round(sc.sh * 10000) / 10000 : null;
      evt.session_low       = sc ? Math.round(sc.sl * 10000) / 10000 : null;
      evt.dist_session_high = sc?.distSH ?? null;
      evt.dist_session_low  = sc?.distSL ?? null;

      // Context flags & environment summary
      const baseSnap = ctxSnapMap.get(evt.timestamp);
      if (baseSnap) {
        const ctxSnap: CtxSnap = {
          ...baseSnap,
          breakout_type:          evt.breakout_type,
          breakout_quality_score: evt.breakout_quality_score,
        };
        const ctxEvt: CtxEvent = {
          direction:             evt.direction,
          event_confluence_score: evt.confluence_score,
          event_grade:           evt.setup_grade,
        };
        evt.context_flags        = buildContextFlags(ctxSnap, ctxEvt);
        evt.environment_summary  = buildEnvironmentSummary(ctxSnap, ctxEvt);
      }
    }

    const accepted = events.filter(e => e.is_accepted);
    const rejected = events.filter(e => !e.is_accepted);
    const scores = events.map(e => e.displacement_quality);
    const avgQ = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length * 1000) / 1000 : 0;

    // Regime distribution
    const regimeDist = { TREND: 0, RANGE: 0, TRANSITION: 0 };
    for (const r of regimeSeries) regimeDist[r.regime]++;
    const lastRegime = regimeSeries.length > 0 ? regimeSeries[regimeSeries.length - 1].regime : "TRANSITION";

    // Volatility distribution
    const volDist = { LOW: 0, MEDIUM: 0, HIGH: 0 };
    for (const v of volStates) volDist[v as keyof typeof volDist]++;
    const currentVolState = volStates.length > 0 ? volStates[volStates.length - 1] : "MEDIUM";

    // Trend distribution
    const trendDist = { UP: 0, DOWN: 0, NEUTRAL: 0 };
    for (const tp of trendSeries) trendDist[tp.direction]++;
    const lastTrend = trendSeries.length > 0 ? trendSeries[trendSeries.length - 1] : { direction: "NEUTRAL", score: 0 };
    const currentTrendDirection = lastTrend.direction;
    const currentTrendScore = lastTrend.score;

    // Volume distribution
    const volumeDist = { IN_VALUE: 0, ACCEPTING_ABOVE: 0, ACCEPTING_BELOW: 0, REJECTING_ABOVE: 0, REJECTING_BELOW: 0 };
    for (const vp of volumeSeries) volumeDist[vp.state]++;
    const lastVolume = volumeSeries.length > 0 ? volumeSeries[volumeSeries.length - 1] : null;
    const round4 = (v: number) => Math.round(v * 10000) / 10000;

    // Liquidity draw distribution
    const liqDrawDist = { ABOVE: 0, BELOW: 0, NEUTRAL: 0 };
    for (const ld of liquidityDrawSeries) liqDrawDist[ld.direction]++;
    const lastLiqDraw = liquidityDrawSeries.length > 0
      ? liquidityDrawSeries[liquidityDrawSeries.length - 1]
      : null;

    // MTF alignment distribution
    const mtfAlignDist: Record<string, number> = {
      FULL_ALIGN_UP: 0, FULL_ALIGN_DOWN: 0,
      PARTIAL_ALIGN_UP: 0, PARTIAL_ALIGN_DOWN: 0,
      CONFLICT: 0, WEAK_ALIGN: 0,
    };
    for (const ma of mtfAlignSeries) mtfAlignDist[ma.mtf_alignment_state]++;
    const lastMTFAlign = mtfAlignSeries.length > 0
      ? mtfAlignSeries[mtfAlignSeries.length - 1]
      : null;

    // Participation distribution + last state
    const participationDist = { LOW_ACTIVITY: 0, NORMAL: 0, ELEVATED: 0, EXTREME: 0 };
    for (const p of participationSeries) participationDist[p.participation_state]++;
    const lastParticipation = participationSeries.length > 0
      ? participationSeries[participationSeries.length - 1]
      : null;

    // Current session H/L (last bar)
    const lastSC = dataBars.length > 0 ? sessionCtxMap.get(dataBars[dataBars.length - 1].t) : null;

    const confDist: Record<string, number> = {
      NO_TRADE: 0, MEDIUM_SETUP: 0, HIGH_SETUP: 0, A_PLUS_SETUP: 0,
    };
    for (const c of confSeries) confDist[c.setup_grade]++;
    const lastConf = confSeries.length > 0 ? confSeries[confSeries.length - 1] : null;

    return NextResponse.json({
      symbol,
      date: dateStr,
      total_candles: dataBars.length,
      atr: Math.round(atr * 10000) / 10000,
      control_points: cps.length,
      total_mss: events.length,
      accepted: accepted.length,
      rejected: rejected.length,
      avg_displacement_quality: avgQ,
      pdh: daily.pdh,
      pdl: daily.pdl,
      current_regime: lastRegime,
      regime_distribution: regimeDist,
      current_volatility_state: currentVolState,
      volatility_distribution: volDist,
      current_trend_direction: currentTrendDirection,
      current_trend_score: currentTrendScore,
      trend_direction_distribution: trendDist,
      current_volume_state: lastVolume?.state ?? "IN_VALUE",
      current_vwap: lastVolume ? round4(lastVolume.vwap) : null,
      current_poc: lastVolume ? round4(lastVolume.poc) : null,
      current_vah: lastVolume ? round4(lastVolume.vah) : null,
      current_val: lastVolume ? round4(lastVolume.val) : null,
      volume_state_distribution: volumeDist,
      current_liquidity_draw_direction: lastLiqDraw?.direction ?? "NEUTRAL",
      current_liquidity_magnet_score: lastLiqDraw?.magnet_score ?? 0,
      liquidity_draw_distribution: liqDrawDist,
      current_htf_bias: lastMTFAlign?.htf_bias ?? "RANGE",
      current_mtf_structure_bias: lastMTFAlign?.mtf_structure_bias ?? "NEUTRAL",
      current_mtf_alignment_state: lastMTFAlign?.mtf_alignment_state ?? "WEAK_ALIGN",
      current_mtf_alignment_score: lastMTFAlign?.mtf_alignment_score ?? 0,
      mtf_alignment_distribution: mtfAlignDist,
      current_confluence_score: lastConf?.confluence_score ?? 0,
      current_setup_grade: lastConf?.setup_grade ?? "NO_TRADE",
      current_trade_bias: lastConf?.trade_bias ?? "NEUTRAL",
      current_confluence_components: lastConf?.confluence_components ?? null,
      confluence_distribution: confDist,
      current_participation_state: lastParticipation?.participation_state ?? "NORMAL",
      current_rvol_ratio: lastParticipation?.rvol_ratio ?? 1.0,
      current_volume_spike: lastParticipation?.volume_spike_flag ?? false,
      participation_state_distribution: participationDist,
      current_session_high: lastSC && isFinite(lastSC.sh) ? Math.round(lastSC.sh * 10000) / 10000 : null,
      current_session_low:  lastSC && isFinite(lastSC.sl) ? Math.round(lastSC.sl * 10000) / 10000 : null,
      current_environment_summary: currentEnvSummary,
      events,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `MSS pipeline failed: ${message}` }, { status: 500 });
  }
}
