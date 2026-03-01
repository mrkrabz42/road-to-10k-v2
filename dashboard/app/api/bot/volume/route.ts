import { NextRequest, NextResponse } from "next/server";
import { fetchBars, type Bar } from "@/lib/mss-pipeline";

// ── Config (mirrors VolumeConfig in bot/structure/config.py) ────────────────
const NUM_BINS = 40;
const VALUE_AREA_FRACTION = 0.70;
const ACCEPTANCE_MIN_BARS = 3;

// ── VWAP ────────────────────────────────────────────────────────────────────
function computeSessionVWAP(bars: Bar[]): number[] {
  const result: number[] = new Array(bars.length).fill(NaN);
  let cumNum = 0;
  let cumDen = 0;
  for (let i = 0; i < bars.length; i++) {
    const tp = (bars[i].h + bars[i].l + bars[i].c) / 3;
    cumNum += tp * bars[i].v;
    cumDen += bars[i].v;
    result[i] = cumDen > 0 ? cumNum / cumDen : NaN;
  }
  return result;
}

// ── Volume Profile ───────────────────────────────────────────────────────────
interface ProfileStats {
  poc: number;
  vah: number;
  val: number;
}

function computeProfileStats(bars: Bar[]): ProfileStats | null {
  if (bars.length === 0) return null;

  const tps = bars.map((b) => (b.h + b.l + b.c) / 3);
  const priceMin = Math.min(...tps);
  const priceMax = Math.max(...tps);

  if (priceMin === priceMax) return { poc: priceMin, vah: priceMin, val: priceMin };

  const binWidth = (priceMax - priceMin) / NUM_BINS;
  const binVolumes = new Array(NUM_BINS).fill(0);
  const binPrices: number[] = Array.from({ length: NUM_BINS }, (_, i) => priceMin + i * binWidth);

  for (let i = 0; i < bars.length; i++) {
    let bi = Math.floor((tps[i] - priceMin) / binWidth);
    bi = Math.max(0, Math.min(NUM_BINS - 1, bi));
    binVolumes[bi] += bars[i].v;
  }

  // POC — highest-volume bin
  let pocBin = 0;
  for (let i = 1; i < NUM_BINS; i++) {
    if (binVolumes[i] > binVolumes[pocBin]) pocBin = i;
  }
  const poc = binPrices[pocBin];

  // Value Area (70% of total volume, expanding from POC outward)
  const totalVol = binVolumes.reduce((a, b) => a + b, 0);
  if (totalVol === 0) return { poc, vah: poc, val: poc };

  const target = totalVol * VALUE_AREA_FRACTION;
  const sortedBins = Array.from({ length: NUM_BINS }, (_, i) => i).sort(
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

  const vah = binPrices[Math.max(...vaBins)] + binWidth; // upper edge of highest bin
  const val = binPrices[Math.min(...vaBins)];              // lower edge of lowest bin

  return { poc, vah, val };
}

// ── Volume state classification ──────────────────────────────────────────────
type VolumeState =
  | "IN_VALUE"
  | "ACCEPTING_ABOVE"
  | "ACCEPTING_BELOW"
  | "REJECTING_ABOVE"
  | "REJECTING_BELOW";

interface VolumePoint {
  time: string;
  vwap: number;
  poc: number;
  vah: number;
  val: number;
  state: VolumeState;
}

function computeVolumeSeries(bars: Bar[]): VolumePoint[] {
  const vwapArr = computeSessionVWAP(bars);
  const profile = computeProfileStats(bars);

  const poc = profile?.poc ?? NaN;
  const vah = profile?.vah ?? NaN;
  const val = profile?.val ?? NaN;

  const points: VolumePoint[] = [];
  let aboveCounter = 0;
  let belowCounter = 0;

  for (let i = 0; i < bars.length; i++) {
    const close = bars[i].c;
    const vwap = vwapArr[i];

    if (isNaN(poc) || isNaN(vah) || isNaN(val)) {
      aboveCounter = 0;
      belowCounter = 0;
      points.push({ time: bars[i].t, vwap, poc, vah, val, state: "IN_VALUE" });
      continue;
    }

    const inValue = close >= val && close <= vah;
    const aboveValue = close > vah;
    const belowValue = close < val;

    let state: VolumeState;
    if (inValue) {
      aboveCounter = 0;
      belowCounter = 0;
      state = "IN_VALUE";
    } else if (aboveValue) {
      aboveCounter++;
      belowCounter = 0;
      state = aboveCounter >= ACCEPTANCE_MIN_BARS ? "ACCEPTING_ABOVE" : "REJECTING_ABOVE";
    } else if (belowValue) {
      belowCounter++;
      aboveCounter = 0;
      state = belowCounter >= ACCEPTANCE_MIN_BARS ? "ACCEPTING_BELOW" : "REJECTING_BELOW";
    } else {
      state = "IN_VALUE";
    }

    points.push({ time: bars[i].t, vwap, poc, vah, val, state });
  }

  return points;
}

// ── Route handler ────────────────────────────────────────────────────────────
export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol") || "NAS100_USD";
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0)
    );

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

    const dateStr = dataDay.toISOString().slice(0, 10);

    if (dataBars.length === 0) {
      return NextResponse.json({
        symbol,
        date: dateStr,
        total_bars: 0,
        current_vwap: null,
        current_poc: null,
        current_vah: null,
        current_val: null,
        current_volume_state: "IN_VALUE",
        volume_state_distribution: {
          IN_VALUE: 0,
          ACCEPTING_ABOVE: 0,
          ACCEPTING_BELOW: 0,
          REJECTING_ABOVE: 0,
          REJECTING_BELOW: 0,
        },
      });
    }

    const series = computeVolumeSeries(dataBars);
    const last = series[series.length - 1];

    const dist = {
      IN_VALUE: 0,
      ACCEPTING_ABOVE: 0,
      ACCEPTING_BELOW: 0,
      REJECTING_ABOVE: 0,
      REJECTING_BELOW: 0,
    };
    for (const pt of series) dist[pt.state]++;

    const round4 = (v: number) => (isNaN(v) ? null : Math.round(v * 10000) / 10000);

    return NextResponse.json({
      symbol,
      date: dateStr,
      total_bars: series.length,
      current_vwap: round4(last.vwap),
      current_poc: round4(last.poc),
      current_vah: round4(last.vah),
      current_val: round4(last.val),
      current_volume_state: last.state,
      volume_state_distribution: dist,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { error: `Volume pipeline failed: ${message}` },
      { status: 500 }
    );
  }
}
