import { NextRequest, NextResponse } from "next/server";
import { fetchCandles, fetchPrices, fetchAccount } from "@/lib/oanda";
import { INSTRUMENTS, type Instrument } from "@/lib/constants";

function walkBackTradingDay(from: Date, days: number): Date {
  const d = new Date(from);
  let count = 0;
  while (count < days) {
    d.setTime(d.getTime() - 86400000);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) count++;
  }
  return d;
}

function computeADX(bars: { h: number; l: number; c: number }[], period = 14): number {
  if (bars.length < period + 1) return 0;
  let plusDMSum = 0, minusDMSum = 0, trSum = 0;
  const dxValues: number[] = [];

  for (let i = 1; i < bars.length; i++) {
    const high = bars[i].h, low = bars[i].l, prevClose = bars[i - 1].c;
    const prevHigh = bars[i - 1].h, prevLow = bars[i - 1].l;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    const plusDM = high - prevHigh > prevLow - low ? Math.max(high - prevHigh, 0) : 0;
    const minusDM = prevLow - low > high - prevHigh ? Math.max(prevLow - low, 0) : 0;

    if (i <= period) {
      plusDMSum += plusDM; minusDMSum += minusDM; trSum += tr;
      if (i === period) {
        const plusDI = trSum > 0 ? (plusDMSum / trSum) * 100 : 0;
        const minusDI = trSum > 0 ? (minusDMSum / trSum) * 100 : 0;
        const diSum = plusDI + minusDI;
        dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
      }
    } else {
      plusDMSum = plusDMSum - plusDMSum / period + plusDM;
      minusDMSum = minusDMSum - minusDMSum / period + minusDM;
      trSum = trSum - trSum / period + tr;
      const plusDI = trSum > 0 ? (plusDMSum / trSum) * 100 : 0;
      const minusDI = trSum > 0 ? (minusDMSum / trSum) * 100 : 0;
      const diSum = plusDI + minusDI;
      dxValues.push(diSum > 0 ? (Math.abs(plusDI - minusDI) / diSum) * 100 : 0);
    }
  }

  if (dxValues.length === 0) return 0;
  let adx = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / Math.min(period, dxValues.length);
  for (let i = period; i < dxValues.length; i++) {
    adx = (adx * (period - 1) + dxValues[i]) / period;
  }
  return adx;
}

async function buildPathway(inst: Instrument, accountEquity: number, livePrice: number) {
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
  const todayEnd = new Date(todayStart.getTime() + 86400000);
  const prevDay = walkBackTradingDay(todayStart, 1);
  const prevEnd = new Date(prevDay.getTime() + 86400000);
  const weekStart = walkBackTradingDay(todayStart, 5);

  const [todayBars, prevBars, weeklyIntraday] = await Promise.all([
    fetchCandles(inst.symbol, todayStart.toISOString(), todayEnd.toISOString()),
    fetchCandles(inst.symbol, prevDay.toISOString(), prevEnd.toISOString()),
    fetchCandles(inst.symbol, weekStart.toISOString(), todayEnd.toISOString(), "5Min"),
  ]);

  const marketOpen = todayBars.length > 0;
  const candleBars = marketOpen ? todayBars : prevBars;

  let liveCandle = { open: 0, high: 0, low: 0, close: 0, volume: 0 };
  if (candleBars.length > 0) {
    const open = candleBars[0].o;
    let high = -Infinity, low = Infinity, vol = 0;
    for (const b of candleBars) {
      if (b.h > high) high = b.h;
      if (b.l < low) low = b.l;
      vol += b.v;
    }
    let close = candleBars[candleBars.length - 1].c;
    if (marketOpen && livePrice > 0) {
      close = livePrice;
      if (close > high) high = close;
      if (close < low) low = close;
    }
    liveCandle = { open, high, low, close, volume: vol };
  }

  const displayPrice = livePrice || liveCandle.close;
  const dayOpen = candleBars.length > 0 ? candleBars[0].o : 0;
  const priceChange = displayPrice - dayOpen;
  const priceChangePct = dayOpen > 0 ? priceChange / dayOpen : 0;

  let pdh = 0, pdl = 0;
  if (prevBars.length > 0) {
    pdh = -Infinity; pdl = Infinity;
    for (const b of prevBars) {
      if (b.h > pdh) pdh = b.h;
      if (b.l < pdl) pdl = b.l;
    }
  }

  const currentPrice = displayPrice || liveCandle.close;
  let targetLiquidity = { label: "P.D.H", direction: "up" as "up" | "down" };
  if (currentPrice > 0 && pdh > 0 && pdl > 0) {
    const distToHigh = Math.abs(pdh - currentPrice);
    const distToLow = Math.abs(currentPrice - pdl);
    targetLiquidity = distToHigh <= distToLow
      ? { label: "P.D.H", direction: "up" }
      : { label: "P.D.L", direction: "down" };
  }

  const adxBars = todayBars.length > 15 ? todayBars : prevBars;
  const adx = computeADX(adxBars);
  const marketState = adx > 25 ? "TREND" : adx > 15 ? "TRANSITION" : "RANGE";

  let bias: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
  if (liveCandle.close > 0 && liveCandle.open > 0) {
    if (liveCandle.close > liveCandle.open && currentPrice > pdh * 0.998) bias = "BULLISH";
    else if (liveCandle.close < liveCandle.open && currentPrice < pdl * 1.002) bias = "BEARISH";
    else if (liveCandle.close > liveCandle.open) bias = "BULLISH";
    else if (liveCandle.close < liveCandle.open) bias = "BEARISH";
  }

  let bullFactors = 0, bearFactors = 0;
  if (liveCandle.close > liveCandle.open) bullFactors++; else if (liveCandle.close < liveCandle.open) bearFactors++;
  if (marketState === "TREND") { if (bias === "BULLISH") bullFactors++; else bearFactors++; }
  if (currentPrice > pdh) bullFactors++;
  if (currentPrice < pdl) bearFactors++;
  if (adx > 25) { if (bias === "BULLISH") bullFactors++; else bearFactors++; }
  if (candleBars.length > 10) {
    const midIdx = Math.floor(candleBars.length / 2);
    const fAvg = candleBars.slice(0, midIdx).reduce((s, b) => s + b.c, 0) / midIdx;
    const sAvg = candleBars.slice(midIdx).reduce((s, b) => s + b.c, 0) / (candleBars.length - midIdx);
    if (sAvg > fAvg) bullFactors++; else bearFactors++;
  }
  const confidenceRatio = `${Math.max(bullFactors, 1)}/${Math.max(bearFactors, 1)}`;

  let score = 50;
  if (marketState === "TREND") score += 15; else if (marketState === "RANGE") score -= 10;
  if (adx > 30) score += 10; else if (adx > 20) score += 5;
  if (Math.abs(priceChangePct) < 0.002) score -= 5;
  if (bias !== "NEUTRAL") score += 5;
  if (bullFactors > bearFactors + 2) score += 10; else if (bearFactors > bullFactors + 2) score += 5;
  if (currentPrice > pdh || currentPrice < pdl) score += 8;
  score = Math.max(0, Math.min(100, Math.round(score)));

  const weekLine: { time: string; price: number }[] = [];
  for (const b of weeklyIntraday) weekLine.push({ time: b.t, price: b.c });

  const dayLabels: { label: string; index: number }[] = [];
  let lastDay = "";
  for (let i = 0; i < weekLine.length; i++) {
    const d = new Date(weekLine[i].time);
    const dayStr = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "America/New_York" });
    if (dayStr !== lastDay) { dayLabels.push({ label: dayStr, index: i }); lastDay = dayStr; }
  }

  return {
    symbol: inst.symbol,
    displayName: inst.displayName,
    shortName: inst.shortName,
    timestamp: now.toISOString(),
    marketOpen,
    accountEquity,
    displayPrice,
    priceChange,
    priceChangePct,
    liveCandle,
    bias,
    marketState,
    confidenceRatio,
    targetLiquidity,
    strategyScore: score,
    weekLine,
    dayLabels,
    pdh,
    pdl,
    adx: Math.round(adx * 10) / 10,
  };
}

export async function GET(req: NextRequest) {
  try {
    const symbolParam = req.nextUrl.searchParams.get("symbol");

    // Fetch account + live prices in parallel
    const allSymbols = INSTRUMENTS.map((i) => i.symbol);
    const [account, prices] = await Promise.all([
      fetchAccount(),
      fetchPrices(allSymbols),
    ]);

    if (symbolParam) {
      // Single instrument
      const inst = INSTRUMENTS.find((i) => i.symbol === symbolParam);
      if (!inst) return NextResponse.json({ error: `Unknown instrument: ${symbolParam}` }, { status: 400 });
      const data = await buildPathway(inst, account.equity, prices[inst.symbol] ?? 0);
      return NextResponse.json(data);
    }

    // All instruments
    const results = await Promise.all(
      INSTRUMENTS.map((inst) => buildPathway(inst, account.equity, prices[inst.symbol] ?? 0))
    );

    return NextResponse.json(results);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Pathway data failed: ${message}` }, { status: 500 });
  }
}
