import useSWR from "swr";
import { REFRESH_INTERVALS } from "@/lib/constants";

export interface PathwayData {
  symbol: string;
  displayName: string;
  shortName: string;
  timestamp: string;
  marketOpen: boolean;
  accountEquity: number;
  displayPrice: number;
  priceChange: number;
  priceChangePct: number;
  liveCandle: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  bias: "BULLISH" | "BEARISH" | "NEUTRAL";
  marketState: "TREND" | "RANGE" | "TRANSITION";
  confidenceRatio: string;
  targetLiquidity: {
    label: string;
    direction: "up" | "down";
  };
  strategyScore: number;
  weekLine: {
    time: string;
    price: number;
  }[];
  dayLabels: {
    label: string;
    index: number;
  }[];
  pdh: number;
  pdl: number;
  adx: number;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function usePathway(symbol?: string) {
  const url = symbol ? `/api/pathway?symbol=${symbol}` : "/api/pathway";
  const { data, error, isLoading } = useSWR<PathwayData | PathwayData[]>(
    url,
    fetcher,
    { refreshInterval: REFRESH_INTERVALS.BOT_STATUS }
  );

  // If single symbol requested, data is a single object; otherwise array
  if (symbol) {
    return { pathway: (data as PathwayData) ?? null, error, isLoading };
  }

  return { pathway: data ?? null, error, isLoading };
}

export function useAllPathways() {
  const { data, error, isLoading } = useSWR<PathwayData[]>(
    "/api/pathway",
    fetcher,
    { refreshInterval: REFRESH_INTERVALS.BOT_STATUS }
  );
  return { pathways: data ?? [], error, isLoading };
}
