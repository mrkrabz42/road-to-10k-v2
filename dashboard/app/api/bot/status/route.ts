import { NextRequest, NextResponse } from "next/server";
import { fetchCandles, type Bar } from "@/lib/oanda";

// Session definitions (UTC)
const SESSIONS = [
  { name: "ASIA", label: "Asia / Pacific", start: 0, end: 360 },
  { name: "LONDON", label: "London / Europe", start: 360, end: 720 },
  { name: "NY", label: "New York", start: 810, end: 1200 },
] as const;

function getSessionForMinute(minuteOfDay: number): string {
  for (const s of SESSIONS) {
    if (minuteOfDay >= s.start && minuteOfDay < s.end) return s.name;
  }
  return "OUTSIDE";
}

function getSessionProgress(nowMinutes: number) {
  for (const s of SESSIONS) {
    if (nowMinutes >= s.start && nowMinutes < s.end) {
      const elapsed = nowMinutes - s.start;
      const total = s.end - s.start;
      return {
        session: s.name,
        label: s.label,
        progress_pct: Math.round((elapsed / total) * 1000) / 10,
        elapsed_min: elapsed,
        remaining_min: total - elapsed,
        start_utc: `${String(Math.floor(s.start / 60)).padStart(2, "0")}:${String(s.start % 60).padStart(2, "0")}`,
        end_utc: `${String(Math.floor(s.end / 60)).padStart(2, "0")}:${String(s.end % 60).padStart(2, "0")}`,
      };
    }
  }
  return {
    session: "OUTSIDE",
    label: "Outside Sessions",
    progress_pct: 0,
    elapsed_min: 0,
    remaining_min: 0,
    start_utc: null,
    end_utc: null,
  };
}

function computeSessionLevels(bars: Bar[]) {
  const sessionData: Record<string, { highs: { price: number; time: string }[]; lows: { price: number; time: string }[]; count: number }> = {};

  for (const s of SESSIONS) {
    sessionData[s.name] = { highs: [], lows: [], count: 0 };
  }

  for (const bar of bars) {
    const dt = new Date(bar.t);
    const minuteOfDay = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    const session = getSessionForMinute(minuteOfDay);

    if (session === "OUTSIDE" || !sessionData[session]) continue;

    sessionData[session].count++;
    sessionData[session].highs.push({ price: bar.h, time: bar.t });
    sessionData[session].lows.push({ price: bar.l, time: bar.t });
  }

  return SESSIONS.map((s) => {
    const data = sessionData[s.name];
    if (data.count === 0) {
      return { session: s.name, label: s.label, high: null, high_time: null, low: null, low_time: null, bar_count: 0 };
    }

    let bestHigh = data.highs[0];
    for (const h of data.highs) {
      if (h.price > bestHigh.price) bestHigh = h;
    }

    let bestLow = data.lows[0];
    for (const l of data.lows) {
      if (l.price < bestLow.price) bestLow = l;
    }

    return {
      session: s.name,
      label: s.label,
      high: bestHigh.price,
      high_time: bestHigh.time,
      low: bestLow.price,
      low_time: bestLow.time,
      bar_count: data.count,
    };
  });
}

function computeDailyExtremes(bars: Bar[]) {
  if (bars.length === 0) return { pdh: null, pdh_time: null, pdh_session: null, pdl: null, pdl_time: null, pdl_session: null, date: null };

  let bestHigh = { price: bars[0].h, time: bars[0].t };
  let bestLow = { price: bars[0].l, time: bars[0].t };

  for (const bar of bars) {
    if (bar.h > bestHigh.price) bestHigh = { price: bar.h, time: bar.t };
    if (bar.l < bestLow.price) bestLow = { price: bar.l, time: bar.t };
  }

  const highDt = new Date(bestHigh.time);
  const lowDt = new Date(bestLow.time);
  const highMin = highDt.getUTCHours() * 60 + highDt.getUTCMinutes();
  const lowMin = lowDt.getUTCHours() * 60 + lowDt.getUTCMinutes();

  return {
    pdh: bestHigh.price,
    pdh_time: bestHigh.time,
    pdh_session: getSessionForMinute(highMin),
    pdl: bestLow.price,
    pdl_time: bestLow.time,
    pdl_session: getSessionForMinute(lowMin),
    date: highDt.toISOString().slice(0, 10),
  };
}

export async function GET(req: NextRequest) {
  try {
    const symbol = req.nextUrl.searchParams.get("symbol") || "NAS100_USD";
    const now = new Date();

    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0));
    const todayEnd = new Date(todayStart.getTime() + 86400000);

    // Previous trading day (skip weekends)
    const prevDay = new Date(todayStart.getTime() - 86400000);
    const day = prevDay.getUTCDay();
    if (day === 0) prevDay.setTime(prevDay.getTime() - 2 * 86400000);
    else if (day === 6) prevDay.setTime(prevDay.getTime() - 86400000);
    const prevEnd = new Date(prevDay.getTime() + 86400000);

    const [todayBars, prevBars] = await Promise.all([
      fetchCandles(symbol, todayStart.toISOString(), todayEnd.toISOString()),
      fetchCandles(symbol, prevDay.toISOString(), prevEnd.toISOString()),
    ]);

    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();

    const isHoliday = todayBars.length === 0;
    let sessionBars = todayBars;
    let dailyBars = prevBars;
    let dataDate: string | undefined;

    if (isHoliday && prevBars.length > 0) {
      sessionBars = prevBars;
      dataDate = prevDay.toISOString().slice(0, 10);

      const prevPrevDay = new Date(prevDay.getTime() - 86400000);
      const ppDay = prevPrevDay.getUTCDay();
      if (ppDay === 0) prevPrevDay.setTime(prevPrevDay.getTime() - 2 * 86400000);
      else if (ppDay === 6) prevPrevDay.setTime(prevPrevDay.getTime() - 86400000);
      const prevPrevEnd = new Date(prevPrevDay.getTime() + 86400000);

      dailyBars = await fetchCandles(symbol, prevPrevDay.toISOString(), prevPrevEnd.toISOString());
    }

    const result: Record<string, unknown> = {
      timestamp: now.toISOString(),
      symbol,
      current_session: getSessionProgress(nowMinutes),
      sessions: computeSessionLevels(sessionBars),
      daily: computeDailyExtremes(dailyBars),
    };

    if (isHoliday) {
      result.is_holiday = true;
      result.data_date = dataDate;
    }

    return NextResponse.json(result);
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Failed to compute bot status: ${message}` }, { status: 500 });
  }
}
