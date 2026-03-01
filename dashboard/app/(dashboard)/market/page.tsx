"use client";

import { useSearchParams, useRouter } from "next/navigation";
import { useState, useCallback, Suspense } from "react";
import useSWR from "swr";
import { ArrowLeft, ArrowUp, ArrowDown } from "lucide-react";
import { LiveChart, type BarData } from "@/components/charts/live-chart";
import { getInstrument, formatInstrumentPrice } from "@/lib/constants";
import { cn } from "@/lib/utils";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const TIMEFRAMES = [
  { label: "1m", value: "1Min", days: 2 },
  { label: "5m", value: "5Min", days: 5 },
  { label: "15m", value: "15Min", days: 10 },
  { label: "30m", value: "30Min", days: 15 },
  { label: "1h", value: "1Hour", days: 30 },
  { label: "4h", value: "4Hour", days: 60 },
  { label: "1D", value: "1Day", days: 365 },
];

type Timeframe = (typeof TIMEFRAMES)[number];

function MarketViewInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const symbol = searchParams.get("symbol") || "NAS100_USD";
  const instrument = getInstrument(symbol);
  const displayName = instrument?.displayName ?? symbol;

  const [timeframe, setTimeframe] = useState<Timeframe>(TIMEFRAMES[1]);
  const [crosshair, setCrosshair] = useState<{
    time: string; open: number; high: number; low: number; close: number; volume: number;
  } | null>(null);

  const { data, isLoading } = useSWR(
    `/api/market-bars?symbol=${symbol}&timeframe=${timeframe.value}&days=${timeframe.days}`,
    fetcher,
    { refreshInterval: 10_000 }
  );

  const bars: BarData[] = data?.bars ?? [];
  const livePrice: number = data?.livePrice ?? 0;

  const lastBar = bars.length > 0 ? bars[bars.length - 1] : null;
  const displayBar = crosshair || (lastBar ? {
    time: lastBar.t,
    open: lastBar.o,
    high: lastBar.h,
    low: lastBar.l,
    close: lastBar.c,
    volume: lastBar.v,
  } : null);

  const firstBar = bars.length > 0 ? bars[0] : null;
  const currentPrice = livePrice || (lastBar?.c ?? 0);
  const openPrice = firstBar?.o ?? 0;
  const change = currentPrice - openPrice;
  const changePct = openPrice > 0 ? change / openPrice : 0;
  const isPositive = change >= 0;

  const fmtPrice = (v: number) => formatInstrumentPrice(v, symbol);

  const handleCrosshairMove = useCallback((data: typeof crosshair) => {
    setCrosshair(data);
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)] -m-6">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-background/50 flex-shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => router.push("/")}
            className="text-muted-foreground hover:text-white transition-colors"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <div className="flex items-center gap-3">
            <span className="text-lg font-bold text-white">{instrument?.shortName ?? symbol}</span>
            <span className="text-sm text-muted-foreground">{displayName}</span>
          </div>

          <div className="flex items-center gap-2 ml-4">
            <span className="text-lg font-bold text-white">
              ${fmtPrice(currentPrice)}
            </span>
            <span className={cn(
              "flex items-center gap-0.5 text-sm font-semibold",
              isPositive ? "text-success" : "text-loss"
            )}>
              {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
              {isPositive ? "+" : ""}{fmtPrice(Math.abs(change))}
              {" "}({isPositive ? "+" : ""}{(changePct * 100).toFixed(2)}%)
            </span>
          </div>
        </div>

        {/* OHLCV display */}
        {displayBar && (
          <div className="hidden md:flex items-center gap-4 text-xs font-mono">
            <span className="text-muted-foreground">O <span className="text-white">{fmtPrice(displayBar.open)}</span></span>
            <span className="text-muted-foreground">H <span className="text-success">{fmtPrice(displayBar.high)}</span></span>
            <span className="text-muted-foreground">L <span className="text-loss">{fmtPrice(displayBar.low)}</span></span>
            <span className="text-muted-foreground">C <span className="text-white">{fmtPrice(displayBar.close)}</span></span>
            <span className="text-muted-foreground">V <span className="text-blue-400">{Math.round(displayBar.volume).toLocaleString()}</span></span>
          </div>
        )}
      </div>

      {/* Timeframe selector */}
      <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border bg-background/30 flex-shrink-0">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf.value}
            onClick={() => setTimeframe(tf)}
            className={cn(
              "px-3 py-1 rounded text-xs font-medium transition-colors",
              tf.value === timeframe.value
                ? "bg-blue-600 text-white"
                : "text-muted-foreground hover:text-white hover:bg-white/5"
            )}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {/* Chart */}
      <div className="flex-1 min-h-0">
        {isLoading && bars.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            Loading {displayName} data...
          </div>
        ) : (
          <LiveChart
            bars={bars}
            livePrice={livePrice}
            symbol={symbol}
            onCrosshairMove={handleCrosshairMove}
          />
        )}
      </div>
    </div>
  );
}

export default function MarketPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground">Loading...</div>}>
      <MarketViewInner />
    </Suspense>
  );
}
