import { NextRequest, NextResponse } from "next/server";
import { fetchCandles, fetchPrices } from "@/lib/oanda";

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol") || "NAS100_USD";
    const timeframe = req.nextUrl.searchParams.get("timeframe") || "5Min";
    const days = parseInt(req.nextUrl.searchParams.get("days") || "5", 10);

    const now = new Date();
    const start = new Date(now.getTime() - days * 86400000);

    // Skip weekends for start date
    while (start.getUTCDay() === 0 || start.getUTCDay() === 6) {
      start.setTime(start.getTime() - 86400000);
    }

    const [bars, prices] = await Promise.all([
      fetchCandles(symbol, start.toISOString(), now.toISOString(), timeframe),
      fetchPrices([symbol]),
    ]);

    return NextResponse.json({
      symbol,
      timeframe,
      bars,
      livePrice: prices[symbol] ?? 0,
      count: bars.length,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Market bars failed: ${message}` }, { status: 500 });
  }
}
