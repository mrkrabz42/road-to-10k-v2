// Timezone & Market types

export type TimezoneKey = "london" | "new_york" | "tokyo" | "hong_kong" | "sydney";

export interface TimezoneOption {
  key: TimezoneKey;
  label: string;
  flag: string;
  iana: string;
  abbr: string;
  exchange: string;
}

export interface MarketSession {
  open: string; // "HH:mm"
  close: string; // "HH:mm"
}

export interface MarketConfig {
  exchangeName: string;
  timezone: string; // IANA timezone
  sessions: MarketSession[];
  extendedHours?: { preMarket: MarketSession; afterHours: MarketSession };
  weekends: number[]; // day-of-week (0=Sun, 6=Sat)
}

export type MarketStatus = "open" | "pre_market" | "after_hours" | "closed";

export interface MarketStatusResult {
  status: MarketStatus;
  label: string;
  countdown: string;
  dotColor: string;
}

// Navigation
export interface NavItem {
  key: string;
  label: string;
  icon: string;
  href: string;
}

// Bot Status / Session Liquidity
export interface SessionLevel {
  session: string;
  label: string;
  high: number | null;
  high_time: string | null;
  low: number | null;
  low_time: string | null;
  bar_count: number;
}

export interface DailyLevel {
  pdh: number | null;
  pdh_time: string | null;
  pdh_session: string | null;
  pdl: number | null;
  pdl_time: string | null;
  pdl_session: string | null;
  date: string;
}

export interface SessionProgress {
  session: string;
  label: string;
  progress_pct: number;
  elapsed_min: number;
  remaining_min: number;
  start_utc: string | null;
  end_utc: string | null;
}

export interface BotStatus {
  timestamp: string;
  symbol: string;
  current_session: SessionProgress;
  sessions: SessionLevel[];
  daily: DailyLevel;
  is_holiday?: boolean;
  data_date?: string;
}
