export const REFRESH_INTERVALS = {
  BOT_STATUS: 10_000,
} as const;

import type { TimezoneKey, TimezoneOption, MarketConfig, NavItem } from "./types";

export const LOCALSTORAGE_KEY_TZ = "mr10krabs_timezone";

export const TIMEZONE_OPTIONS: TimezoneOption[] = [
  { key: "london", label: "London", flag: "\u{1F1EC}\u{1F1E7}", iana: "Europe/London", abbr: "GMT/BST", exchange: "LSE" },
  { key: "new_york", label: "New York", flag: "\u{1F1FA}\u{1F1F8}", iana: "America/New_York", abbr: "ET", exchange: "NYSE/NASDAQ" },
  { key: "tokyo", label: "Tokyo", flag: "\u{1F1EF}\u{1F1F5}", iana: "Asia/Tokyo", abbr: "JST", exchange: "TSE" },
  { key: "hong_kong", label: "Hong Kong", flag: "\u{1F1ED}\u{1F1F0}", iana: "Asia/Hong_Kong", abbr: "HKT", exchange: "HKEX" },
  { key: "sydney", label: "Sydney", flag: "\u{1F1E6}\u{1F1FA}", iana: "Australia/Sydney", abbr: "AEST", exchange: "ASX" },
];

export const MARKET_HOURS: Record<TimezoneKey, MarketConfig> = {
  london: {
    exchangeName: "LSE",
    timezone: "Europe/London",
    sessions: [{ open: "08:00", close: "16:30" }],
    weekends: [0, 6],
  },
  new_york: {
    exchangeName: "NYSE/NASDAQ",
    timezone: "America/New_York",
    sessions: [{ open: "09:30", close: "16:00" }],
    extendedHours: {
      preMarket: { open: "04:00", close: "09:30" },
      afterHours: { open: "16:00", close: "20:00" },
    },
    weekends: [0, 6],
  },
  tokyo: {
    exchangeName: "TSE",
    timezone: "Asia/Tokyo",
    sessions: [
      { open: "09:00", close: "11:30" },
      { open: "12:30", close: "15:00" },
    ],
    weekends: [0, 6],
  },
  hong_kong: {
    exchangeName: "HKEX",
    timezone: "Asia/Hong_Kong",
    sessions: [
      { open: "09:30", close: "12:00" },
      { open: "13:00", close: "16:00" },
    ],
    weekends: [0, 6],
  },
  sydney: {
    exchangeName: "ASX",
    timezone: "Australia/Sydney",
    sessions: [{ open: "10:00", close: "16:00" }],
    weekends: [0, 6],
  },
};

export const NAV_ITEMS: NavItem[] = [
  { key: "dashboard", label: "Dashboard", icon: "LayoutDashboard", href: "/" },
  { key: "bot", label: "Bot Status", icon: "Activity", href: "/bot" },
  { key: "backtest", label: "Backtest", icon: "CandlestickChart", href: "/backtest" },
];


export const LOCALSTORAGE_KEY_SIDEBAR = "mr10krabs_sidebar_collapsed";
