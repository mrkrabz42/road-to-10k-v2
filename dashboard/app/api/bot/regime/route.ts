import { NextRequest, NextResponse } from "next/server";
import { fetchBars, type Bar } from "@/lib/mss-pipeline";
import { computeRegimeSeries, DEFAULT_REGIME_CONFIG } from "@/lib/regime";

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
        symbol,
        date: todayStart.toISOString().slice(0, 10),
        current_regime: "TRANSITION",
        adx: 0,
        bb_width: 0,
        vwap_distance: 0,
        regime_distribution: { TREND: 0, RANGE: 0, TRANSITION: 0 },
        total_bars: 0,
      });
    }

    const dateStr = dataDay.toISOString().slice(0, 10);
    const series = computeRegimeSeries(dataBars, DEFAULT_REGIME_CONFIG);
    const last = series[series.length - 1];

    const dist = { TREND: 0, RANGE: 0, TRANSITION: 0 };
    for (const pt of series) {
      dist[pt.regime]++;
    }

    return NextResponse.json({
      symbol,
      date: dateStr,
      current_regime: last.regime,
      adx: last.adx,
      bb_width: last.bbWidth,
      vwap_distance: last.vwapDist,
      regime_distribution: dist,
      total_bars: series.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Regime pipeline failed: ${message}` }, { status: 500 });
  }
}
