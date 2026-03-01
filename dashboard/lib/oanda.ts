const BASE_URL = "https://api-fxpractice.oanda.com";

function getHeaders(): Record<string, string> {
  const token = process.env.OANDA_API_TOKEN;
  if (!token) {
    throw new Error("Missing OANDA_API_TOKEN env var");
  }
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function getAccountId(): string {
  const id = process.env.OANDA_ACCOUNT_ID;
  if (!id) {
    throw new Error("Missing OANDA_ACCOUNT_ID env var");
  }
  return id;
}

// Granularity map: dashboard timeframes → OANDA granularity codes
const GRANULARITY_MAP: Record<string, string> = {
  "1Min": "M1",
  "5Min": "M5",
  "15Min": "M15",
  "30Min": "M30",
  "1Hour": "H1",
  "4Hour": "H4",
  "1Day": "D",
};

export interface Bar {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Fetch candles for an OANDA instrument.
 * Handles pagination (max 5000 candles per request) by sliding the `from` window.
 */
export async function fetchCandles(
  instrument: string,
  from: string,
  to: string,
  timeframe = "1Min",
): Promise<Bar[]> {
  const granularity = GRANULARITY_MAP[timeframe] || "M5";
  const allBars: Bar[] = [];
  let currentFrom = from;

  // OANDA rejects future timestamps — clamp `to` to now
  const nowISO = new Date().toISOString();
  const clampedTo = to > nowISO ? nowISO : to;

  // If from >= clampedTo, no data to fetch
  if (currentFrom >= clampedTo) return allBars;

  while (true) {
    const url = `${BASE_URL}/v3/instruments/${instrument}/candles?granularity=${granularity}&from=${encodeURIComponent(currentFrom)}&to=${encodeURIComponent(clampedTo)}&price=M`;

    const res = await fetch(url, {
      headers: getHeaders(),
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OANDA candles API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    const candles = data.candles ?? [];

    if (candles.length === 0) break;

    for (const c of candles) {
      if (!c.mid || !c.complete) continue;
      allBars.push({
        t: c.time,
        o: parseFloat(c.mid.o),
        h: parseFloat(c.mid.h),
        l: parseFloat(c.mid.l),
        c: parseFloat(c.mid.c),
        v: c.volume ?? 0,
      });
    }

    // If we got fewer than 5000, we've reached the end
    if (candles.length < 5000) break;

    // Slide the window forward: use the last candle's time as the new `from`
    const lastTime = candles[candles.length - 1].time;
    if (lastTime === currentFrom) break; // safety: avoid infinite loop
    currentFrom = lastTime;
  }

  return allBars;
}

/**
 * Fetch live mid prices for multiple instruments in one call.
 */
export async function fetchPrices(
  instruments: string[],
): Promise<Record<string, number>> {
  const accountId = getAccountId();
  const csv = instruments.join(",");
  const url = `${BASE_URL}/v3/accounts/${accountId}/pricing?instruments=${encodeURIComponent(csv)}`;

  const res = await fetch(url, {
    headers: getHeaders(),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OANDA pricing API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const prices: Record<string, number> = {};

  for (const p of data.prices ?? []) {
    // Mid price = average of best bid and best ask
    const bid = parseFloat(p.bids?.[0]?.price ?? "0");
    const ask = parseFloat(p.asks?.[0]?.price ?? "0");
    prices[p.instrument] = (bid + ask) / 2;
  }

  return prices;
}

/**
 * Fetch OANDA practice account summary.
 */
export async function fetchAccount(): Promise<{
  equity: number;
  balance: number;
  nav: number;
  unrealizedPL: number;
}> {
  const accountId = getAccountId();
  const url = `${BASE_URL}/v3/accounts/${accountId}`;

  const res = await fetch(url, {
    headers: getHeaders(),
    cache: "no-store",
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OANDA account API error ${res.status}: ${body}`);
  }

  const data = await res.json();
  const acc = data.account;

  return {
    equity: parseFloat(acc?.balance ?? "0") + parseFloat(acc?.unrealizedPL ?? "0"),
    balance: parseFloat(acc?.balance ?? "0"),
    nav: parseFloat(acc?.NAV ?? "0"),
    unrealizedPL: parseFloat(acc?.unrealizedPL ?? "0"),
  };
}
