import { NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface KnowledgeEntry {
  keywords: string[];
  reply: string | ((live: LiveData) => string);
}

interface MSSEvent {
  id: string;
  direction: string;
  price: number;
  control_point_price: number;
  displacement_quality: number;
  is_accepted: boolean;
  rejection_reason: string | null;
  session: string;
  distance_to_pdh: number | null;
  distance_to_pdl: number | null;
  timestamp: string;
}

interface LiveData {
  mss: {
    symbol: string;
    date: string;
    total_mss: number;
    accepted: number;
    rejected: number;
    atr: number;
    control_points: number;
    avg_displacement_quality: number;
    pdh: number | null;
    pdl: number | null;
    events: MSSEvent[];
  } | null;
  status: {
    current_session: { label: string; progress_pct: number; remaining_min: number } | null;
    sessions: { label: string; high: number | null; low: number | null; bar_count: number }[];
    daily: { pdh: number | null; pdl: number | null; pdh_session: string | null; pdl_session: string | null } | null;
  } | null;
  account: {
    equity: number;
    buying_power: number;
    progress: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEvent(e: MSSEvent): string {
  const time = e.timestamp ? new Date(e.timestamp).toISOString().slice(11, 16) + " UTC" : "";
  const status = e.is_accepted ? "Accepted" : `Rejected — ${e.rejection_reason}`;
  let line = `  ${e.id}: ${e.direction} MSS at $${e.price} / CP $${e.control_point_price} (${time}, ${e.session})`;
  line += `\n    Displacement: ${Math.round(e.displacement_quality * 100)}% | ${status}`;
  if (e.distance_to_pdh !== null) line += ` | PDH: ${e.distance_to_pdh > 0 ? "+" : ""}${e.distance_to_pdh}`;
  if (e.distance_to_pdl !== null) line += ` PDL: ${e.distance_to_pdl > 0 ? "+" : ""}${e.distance_to_pdl}`;
  return line;
}

function formatEventList(events: MSSEvent[], label: string, mss: LiveData["mss"]): string {
  if (!mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
  if (events.length === 0) return `No ${label} found for ${mss.symbol} on ${mss.date}.`;

  const accepted = events.filter((e) => e.is_accepted).length;
  const rejected = events.length - accepted;
  const avgQ = events.length
    ? Math.round((events.reduce((s, e) => s + e.displacement_quality, 0) / events.length) * 100)
    : 0;

  let text = `${label} for ${mss.symbol} on ${mss.date}: ${events.length} events (${accepted} accepted, ${rejected} rejected, avg quality ${avgQ}%)`;
  text += `\nATR(14): ${mss.atr}`;
  if (mss.pdh !== null) text += ` | PDH: $${mss.pdh}`;
  if (mss.pdl !== null) text += ` | PDL: $${mss.pdl}`;
  text += "\n";
  for (const e of events) {
    text += "\n" + formatEvent(e);
  }
  return text;
}

// ---------------------------------------------------------------------------
// Knowledge base — ICT MSS Blueprint + bot internals
// ---------------------------------------------------------------------------

const KNOWLEDGE: KnowledgeEntry[] = [

  // ===== CORE: What is MSS =====
  {
    keywords: ["what is mss", "what's mss", "define mss", "mss meaning", "market structure shift"],
    reply: (live) => {
      let base =
        "MSS (Market Structure Shift) is an ICT concept — it's the first signal that a prevailing trend may be reversing.\n\n" +
        "Key distinction from other signals:\n" +
        "- BOS (Break of Structure): break WITH the trend = continuation\n" +
        "- CHoCH (Change of Character): break AGAINST the trend WITHOUT displacement = warning only\n" +
        "- MSS: break AGAINST the trend WITH displacement = reversal signal\n" +
        "- Liquidity Sweep: wick pierces a level but body closes back inside = NOT a break\n\n" +
        "A valid MSS requires:\n" +
        "1. An established trend (HH/HL for uptrend, LH/LL for downtrend)\n" +
        "2. Price breaks a key swing level AGAINST the trend\n" +
        "3. The break candle's BODY closes beyond the level (not just a wick)\n" +
        "4. The break happens with displacement (strong, forceful candle)\n" +
        "5. Ideally, a Fair Value Gap (FVG) is left behind confirming institutional conviction";
      if (live.mss) {
        base += `\n\nLive (${live.mss.symbol}, ${live.mss.date}): ${live.mss.total_mss} MSS events — ${live.mss.accepted} accepted, ${live.mss.rejected} rejected.`;
      }
      return base;
    },
  },

  // ===== MSS vs BOS vs CHoCH vs Sweep =====
  {
    keywords: ["bos", "choch", "break of structure", "change of character", "difference", "vs"],
    reply:
      "Decision tree when price breaks a swing level:\n\n" +
      "Price breaks a swing level\n" +
      "  Is the break WITH the existing trend?\n" +
      "    YES -> BOS (Break of Structure) — trend continuation\n" +
      "  Is the break AGAINST the existing trend?\n" +
      "    Was there displacement (large body + FVG)?\n" +
      "      YES -> MSS (Market Structure Shift) — reversal signal\n" +
      "      NO  -> CHoCH (Change of Character) — warning only, no trade\n" +
      "    Did price wick beyond level but CLOSE back inside?\n" +
      "      YES -> Liquidity Sweep — NOT a break, expect continuation\n\n" +
      "The bot must NEVER confuse these. A wick-only pierce without a body close beyond the level is a liquidity sweep, not an MSS.",
  },

  // ===== Swing High / Swing Low =====
  {
    keywords: ["swing high", "swing low", "swing", "control point", "pivot"],
    reply: (live) => {
      let base =
        "Swing High/Low — ICT Three-Candle Definition:\n\n" +
        "Swing High: the high of the middle candle is higher than the highs of both the left and right candles.\n" +
        "  swing_high[i] = high[i] > high[i-1] AND high[i] > high[i+1]\n\n" +
        "Swing Low: the low of the middle candle is lower than the lows of both surrounding candles.\n" +
        "  swing_low[i] = low[i] < low[i-1] AND low[i] < low[i+1]\n\n" +
        "For algorithmic robustness, we use an N-bar lookback (configurable, default N=1 for ICT 3-candle, or N=5 for noise filtering). " +
        "The bar's high/low must be the max/min of the full window (2N+1 bars).\n\n" +
        "These swing points become the control points — the levels that MSS must break through.";
      if (live.mss) {
        base += `\n\nLive: ${live.mss.control_points} control points found for ${live.mss.symbol} on ${live.mss.date}.`;
      }
      return base;
    },
  },

  // ===== Trend Classification =====
  {
    keywords: ["trend", "uptrend", "downtrend", "ranging", "higher high", "lower low", "hh", "hl", "lh", "ll"],
    reply:
      "Trend classification from swing sequence (minimum 4 swings: 2 highs + 2 lows):\n\n" +
      "UPTREND: Higher Highs (HH) + Higher Lows (HL)\n" +
      "  Each successive swing high is above the previous, each swing low is above the previous.\n\n" +
      "DOWNTREND: Lower Highs (LH) + Lower Lows (LL)\n" +
      "  Each successive swing high is below the previous, each swing low is below the previous.\n\n" +
      "RANGING: Mixed — no clear HH/HL or LH/LL pattern.\n\n" +
      "Why it matters: MSS is a REVERSAL signal. The bot must know what trend exists before it can detect a shift.\n" +
      "- Bearish MSS: price was in uptrend (HH/HL), then breaks below the most recent swing low\n" +
      "- Bullish MSS: price was in downtrend (LH/LL), then breaks above the most recent swing high",
  },

  // ===== Displacement (ICT Blueprint) =====
  {
    keywords: ["displacement", "displace"],
    reply:
      "Displacement is a sudden, forceful price shift — large real-body candles with short wicks, often leaving a Fair Value Gap (FVG).\n\n" +
      "The bot uses TWO mechanical checks (both must pass):\n\n" +
      "1. ATR-relative body size:\n" +
      "   candle_body > ATR(14) x multiplier (default 1.5x)\n" +
      "   The body must be significantly larger than average volatility.\n\n" +
      "2. Body-to-range ratio:\n" +
      "   abs(close - open) / (high - low) >= 0.70\n" +
      "   At least 70% of the candle is body — minimal wicks, pure conviction.\n\n" +
      "Current bot config: range >= 1.2x ATR, body >= 60%, opposite wick <= 20%.\n\n" +
      "Critical: without displacement, a structure break is just a CHoCH (warning), not an MSS (actionable signal). " +
      "Displacement separates institutional moves from retail noise.",
  },

  // ===== Fair Value Gap (FVG) =====
  {
    keywords: ["fvg", "fair value gap", "imbalance", "gap"],
    reply:
      "Fair Value Gap (FVG) — a price gap left when one candle's range isn't fully covered by adjacent candles:\n\n" +
      "Bullish FVG: low[i+1] > high[i-1]\n" +
      "  Gap between candle 1's high and candle 3's low — price moved up so fast sellers couldn't fill.\n\n" +
      "Bearish FVG: high[i+1] < low[i-1]\n" +
      "  Gap between candle 1's low and candle 3's high — price dropped too fast for buyers to fill.\n\n" +
      "Where candle i is the displacement candle in the middle.\n\n" +
      "Why it matters for MSS:\n" +
      "- FVG presence after a structure break is one of the STRONGEST confirmations of genuine displacement\n" +
      "- A wick spike without FVG is suspicious — likely a liquidity sweep\n" +
      "- FVG zones become potential re-entry areas when price retraces\n\n" +
      "In the quality scoring formula, FVG presence contributes 15% weight.",
  },

  // ===== Liquidity Sweep =====
  {
    keywords: ["liquidity", "sweep", "false break", "stop hunt", "wick"],
    reply:
      "Liquidity Sweep — the most dangerous false signal. Looks like an MSS but reverses immediately.\n\n" +
      "Detection rule:\n" +
      "  Bearish sweep: wick goes below swing low, but body closes ABOVE it\n" +
      "  Bullish sweep: wick goes above swing high, but body closes BELOW it\n\n" +
      "Key difference:\n" +
      "  MSS: body CLOSES beyond the level + displacement. The move sustains.\n" +
      "  Sweep: price briefly pierces the level (triggering stops), then snaps back.\n\n" +
      "Important twist: if a liquidity sweep happens BEFORE an MSS, it actually INCREASES the quality of that MSS. " +
      "Institutions often sweep liquidity first (grab stop-losses), then displace in the true direction. " +
      "A sweep followed by displacement in the opposite direction is a high-conviction setup.",
  },

  // ===== Quality Score =====
  {
    keywords: ["quality", "score", "scoring", "quality score"],
    reply:
      "MSS Quality Score (0–100%) — weighted formula across 6 factors:\n\n" +
      "1. Displacement Strength (30%): body_size / ATR(14) — perfect if >= 2.0x ATR\n" +
      "2. Body Close (20%): did the body close beyond the level? Body = 100%, wick only = 0%\n" +
      "3. FVG Present (15%): was a Fair Value Gap left behind? Binary yes/no\n" +
      "4. Prior Liquidity Sweep (15%): was opposite liquidity swept before the break? Binary\n" +
      "5. Body-to-Range Ratio (10%): abs(close-open) / (high-low) — perfect if >= 0.80\n" +
      "6. HTF Alignment (10%): does the higher timeframe trend agree with MSS direction?\n\n" +
      "Thresholds:\n" +
      "  >= 65%: ACCEPTED — valid MSS, actionable signal\n" +
      "  40-64%: CONDITIONAL — only with additional confluence (PDH/PDL, order block)\n" +
      "  < 40%: REJECTED — too weak, likely false breakout\n\n" +
      "Current bot: uses a simplified 3-factor score (size, body ratio, wick ratio) averaged 0.0–1.0. " +
      "The full 6-factor formula is the target implementation.",
  },

  // ===== MSS Detection Pipeline (step by step) =====
  {
    keywords: ["pipeline", "how does it work", "how do you work", "detection", "algorithm", "steps", "process"],
    reply:
      "MSS Detection Pipeline — step by step:\n\n" +
      "Step 1: IDENTIFY THE TREND\n" +
      "  Track rolling swing highs/lows. Classify: HH/HL = uptrend, LH/LL = downtrend, mixed = ranging.\n\n" +
      "Step 2: WATCH FOR STRUCTURE BREAK\n" +
      "  Bearish MSS: uptrend + price breaks below most recent swing low (the HL)\n" +
      "  Bullish MSS: downtrend + price breaks above most recent swing high (the LH)\n" +
      "  CRITICAL: body must CLOSE beyond the level. Wick-only = liquidity sweep, not MSS.\n\n" +
      "Step 3: VALIDATE DISPLACEMENT\n" +
      "  Body > ATR(14) x 1.5 AND body/range ratio >= 0.70. Both must pass.\n\n" +
      "Step 4: CHECK FOR FVG\n" +
      "  Look for Fair Value Gap in the 3 candles around the break. Presence = higher conviction.\n\n" +
      "Step 5: FILTER LIQUIDITY SWEEPS\n" +
      "  If body closed back inside the range, it's a sweep — reject.\n\n" +
      "Step 6: SCORE QUALITY\n" +
      "  Apply weighted formula (displacement 30%, body close 20%, FVG 15%, sweep 15%, ratio 10%, HTF 10%)\n\n" +
      "Step 7: ACCEPT/REJECT\n" +
      "  >= 65% accepted. Session multiplier applied (NY 1.0, London 0.95, Asia 0.70, Outside 0.60).",
  },

  // ===== Session Awareness =====
  {
    keywords: ["session window", "session weight", "session reliability", "session multiplier", "what sessions", "which sessions", "trading sessions"],
    reply: (live) => {
      let base =
        "Session windows and MSS reliability:\n\n" +
        "Trading sessions (UTC):\n" +
        "  Asia/Pacific: 00:00–06:00 (20:00–00:00 EST)\n" +
        "  London/Europe: 06:00–12:00 (02:00–05:00 EST open)\n" +
        "  New York: 13:30–20:00 (08:30–11:00 EST key hours)\n\n" +
        "MSS quality multipliers by session:\n" +
        "  NY session: x1.0 — highest volume, often the 'real' move of the day\n" +
        "  London session: x0.95 — institutions set daily direction at London open\n" +
        "  Asia session: x0.70 — lower reliability, often creates liquidity that London/NY will sweep\n" +
        "  Outside session: x0.60 — thin liquidity, displacement can be deceptive\n\n" +
        "Each MSS event is tagged with its session for filtering and scoring.";

      if (live.status?.current_session) {
        const s = live.status.current_session;
        base += `\n\nCurrent: ${s.label} — ${s.progress_pct}% complete, ${s.remaining_min} min remaining.`;
      }
      if (live.status?.sessions) {
        const active = live.status.sessions.filter((s) => s.bar_count > 0);
        if (active.length > 0) {
          base += "\n\nSession levels:";
          for (const s of active) {
            base += `\n  ${s.label}: High $${s.high}, Low $${s.low} (${s.bar_count} bars)`;
          }
        }
      }
      return base;
    },
  },

  // ===== Multi-Timeframe =====
  {
    keywords: ["multi-timeframe", "htf", "higher timeframe", "timeframe", "daily bias", "alignment"],
    reply:
      "Multi-Timeframe MSS Confirmation:\n\n" +
      "Timeframe hierarchy:\n" +
      "  Bias (Daily/4H): overall trend direction — HH/HL or LH/LL sequence\n" +
      "  Structure (1H/15M): MSS detection + FVG identification\n" +
      "  Entry (5M/1M): refined entry on retrace into FVG or Order Block\n\n" +
      "The rule:\n" +
      "  Daily bias bullish -> only accept Bullish MSS on lower timeframes\n" +
      "  Daily bias bearish -> only accept Bearish MSS on lower timeframes\n" +
      "  Daily bias unclear -> no MSS trades, or require very strong confluence\n\n" +
      "Counter-trend MSS (e.g. bearish MSS in a daily uptrend) is rejected unless quality is exceptional.\n\n" +
      "The professional flow: HTF Liquidity -> MSS -> FVG -> LTF MSS -> FVG Entry. " +
      "This multi-layered confirmation separates institutional-grade detection from retail noise.\n\n" +
      "Current bot: HTF alignment contributes 10% weight to the quality score.",
  },

  // ===== PDH/PDL =====
  {
    keywords: ["pdh", "pdl", "previous day", "prev day"],
    reply: (live) => {
      let base =
        "PDH/PDL — Previous Day High and Previous Day Low:\n\n" +
        "Key institutional reference levels. How they integrate with MSS:\n\n" +
        "- MSS near PDH/PDL (within 0.3%): HIGHER confluence — institutional level + structure break\n" +
        "- MSS that breaks THROUGH PDH/PDL as part of displacement: STRONGEST signal — breaking both internal structure and a major daily level\n" +
        "- MSS far from PDH/PDL (>1% away): normal confluence — rely on other quality factors\n\n" +
        "The PDH/PDL delta values on each MSS event can be incorporated as a bonus factor in quality scoring.";
      if (live.status?.daily) {
        const d = live.status.daily;
        if (d.pdh !== null) base += `\n\nLive PDH: $${d.pdh} (${d.pdh_session} session)`;
        if (d.pdl !== null) base += `\nLive PDL: $${d.pdl} (${d.pdl_session} session)`;
      }
      if (live.mss && live.mss.pdh !== null) {
        base += `\nMSS data PDH: $${live.mss.pdh}, PDL: $${live.mss.pdl}`;
      }
      return base;
    },
  },

  // ===== ATR =====
  {
    keywords: ["atr", "average true range", "volatility"],
    reply: (live) => {
      let base =
        "ATR(14) — Average True Range over 14 periods:\n\n" +
        "Calculation: for each bar, true range = max of:\n" +
        "  high - low\n" +
        "  |high - previous close|\n" +
        "  |low - previous close|\n" +
        "ATR = average of true ranges over 14 bars.\n\n" +
        "Role in MSS detection:\n" +
        "- Displacement threshold: candle body must be >= ATR x multiplier (default 1.5x) to qualify as displacement\n" +
        "- FVG minimum size: FVG gap should be >= 0.25x ATR to be meaningful\n" +
        "- Normalizes across different volatility regimes — what counts as 'strong' adapts automatically";
      if (live.mss) {
        base += `\n\nCurrent ATR(14) for ${live.mss.symbol}: ${live.mss.atr}`;
      }
      return base;
    },
  },

  // ===== MSS events — all / today / summary =====
  {
    keywords: ["events today", "mss today", "happened today", "today's events", "recent events", "show me", "identified", "detected", "all events"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      return formatEventList(live.mss.events, "MSS events", live.mss);
    },
  },

  // ===== NY session filter =====
  {
    keywords: ["ny session", "new york session", "ny mss", "new york mss"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.session === "NY");
      return formatEventList(filtered, "NY session MSS events", live.mss);
    },
  },

  // ===== London session filter =====
  {
    keywords: ["london session", "london mss", "europe session"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.session === "LONDON");
      return formatEventList(filtered, "London session MSS events", live.mss);
    },
  },

  // ===== Asia session filter =====
  {
    keywords: ["asia session", "asia mss", "pacific session", "asian session"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.session === "ASIA");
      return formatEventList(filtered, "Asia session MSS events", live.mss);
    },
  },

  // ===== Outside session filter =====
  {
    keywords: ["outside session", "outside mss", "after hours", "off hours"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.session === "OUTSIDE");
      return formatEventList(filtered, "Outside-session MSS events", live.mss);
    },
  },

  // ===== Bull MSS filter =====
  {
    keywords: ["bull mss", "bullish mss", "bullish events", "bull events"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.direction === "BULL");
      return formatEventList(filtered, "Bullish MSS events", live.mss);
    },
  },

  // ===== Bear MSS filter =====
  {
    keywords: ["bear mss", "bearish mss", "bearish events", "bear events"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.direction === "BEAR");
      return formatEventList(filtered, "Bearish MSS events", live.mss);
    },
  },

  // ===== Accepted / rejected filter =====
  {
    keywords: ["accepted events", "accepted mss", "valid mss"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => e.is_accepted);
      return formatEventList(filtered, "Accepted MSS events", live.mss);
    },
  },
  {
    keywords: ["rejected events", "rejected mss", "failed mss", "invalid mss"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      const filtered = live.mss.events.filter((e) => !e.is_accepted);
      return formatEventList(filtered, "Rejected MSS events", live.mss);
    },
  },

  // ===== Best / strongest MSS =====
  {
    keywords: ["best mss", "strongest mss", "highest quality", "best quality", "top mss"],
    reply: (live) => {
      if (!live.mss) return "I couldn't fetch live MSS data right now. Try again in a moment.";
      if (live.mss.events.length === 0) return `No MSS events detected for ${live.mss.symbol} on ${live.mss.date}.`;
      const sorted = [...live.mss.events].sort((a, b) => b.displacement_quality - a.displacement_quality);
      const best = sorted[0];
      let text = `Strongest MSS for ${live.mss.symbol} on ${live.mss.date}:\n\n`;
      text += formatEvent(best);
      text += `\n\nThis event had the highest displacement quality (${Math.round(best.displacement_quality * 100)}%) of all ${live.mss.events.length} events.`;
      if (sorted.length > 1) {
        text += `\n\nRunner-up:\n${formatEvent(sorted[1])}`;
      }
      return text;
    },
  },

  // ===== How does data update / is it live =====
  {
    keywords: ["update", "live data", "real-time", "realtime", "refresh", "when does", "will it change"],
    reply: (live) => {
      let base =
        "Yes — MSS data is live and dynamic.\n\n" +
        "How it works:\n" +
        "- The /api/bot/mss endpoint fetches fresh 1-min bars from OANDA on EVERY request\n" +
        "- It walks back up to 5 days to find the most recent trading day with bars\n" +
        "- The full MSS pipeline (ATR, swings, detection, acceptance) runs on the fetched bars\n" +
        "- When the NY market opens and new bars flow in, the pipeline will detect new MSS events automatically\n\n" +
        "The data you see right now is from the most recent trading day with available bars. " +
        "Once today's market opens and 1-min bars appear, the dashboard and this chat will show today's MSS events instead.";
      if (live.mss) {
        base += `\n\nCurrently showing: ${live.mss.symbol} data from ${live.mss.date} (${live.mss.total_mss} events).`;
      }
      return base;
    },
  },

  // ===== General MSS query (catch-all for "mss") =====
  {
    keywords: ["mss"],
    reply: (live) => {
      let base =
        "MSS (Market Structure Shift) — the core reversal signal in ICT methodology.\n\n" +
        "In short: when an established trend (HH/HL or LH/LL) breaks a key swing level in the OPPOSITE direction, " +
        "with displacement (strong body, minimal wick, FVG left behind), that's an MSS.\n\n" +
        "The bot's detection pipeline:\n" +
        "1. Identify swing highs/lows (ICT 3-candle or N-bar lookback)\n" +
        "2. Classify trend from swing sequence\n" +
        "3. Watch for break against the trend with body close beyond level\n" +
        "4. Validate displacement + check for FVG\n" +
        "5. Filter out liquidity sweeps (wick-only pierces)\n" +
        "6. Score quality (0-100%) and accept/reject (threshold: 65%)\n\n" +
        "Try asking: 'What MSS events happened today?', 'Show me NY session MSS', 'What were the bear MSS?', 'Which was the strongest MSS?'";
      if (live.mss) {
        base += `\n\nLive: ${live.mss.total_mss} events on ${live.mss.date} (${live.mss.accepted} accepted) for ${live.mss.symbol}.`;
      }
      return base;
    },
  },

  // ===== Risk Rules =====
  {
    keywords: ["risk", "stop-loss", "stop loss", "position size", "daily loss", "risk management"],
    reply:
      "Risk rules (hardcoded — NEVER overridden):\n\n" +
      "- Max 2% of portfolio risked per trade\n" +
      "- Max 5 open positions at any time\n" +
      "- Daily loss limit: 5% of portfolio — bot stops trading if hit\n" +
      "- Every order MUST have a stop-loss attached — no exceptions\n" +
      "- Paper trading by default — live trading requires an explicit flag\n\n" +
      "For MSS-based entries, stop-loss goes below/above the MSS origin (the swing level that was broken). " +
      "Entry is on retrace into the FVG or Order Block zone after MSS confirmation.",
  },

  // ===== SMA Crossover =====
  {
    keywords: ["sma", "crossover", "moving average"],
    reply:
      "SMA Crossover strategy:\n\n" +
      "- Fast SMA: 10-period\n" +
      "- Slow SMA: 30-period\n" +
      "- BUY: fast crosses above slow\n" +
      "- SELL: fast crosses below slow\n" +
      "- Signal strength scored by spread magnitude\n\n" +
      "This is the bot's simpler trend-following strategy. All strategies inherit from BaseStrategy " +
      "and return BUY/SELL/HOLD signals. MSS detection is the more sophisticated, ICT-based approach.",
  },

  // ===== Strategy =====
  {
    keywords: ["strategy", "strategies"],
    reply:
      "Current strategies:\n\n" +
      "1. SMA Crossover (10/30) — trend-following, generates BUY/SELL/HOLD signals based on moving average crosses\n\n" +
      "2. MSS (Market Structure Shift) — ICT-based reversal detection using the Bonsai pipeline:\n" +
      "   Swing detection -> Trend classification -> Structure break -> Displacement validation -> FVG check -> Quality scoring\n\n" +
      "Planned: RSI strategy, Momentum strategy, and a Signal Aggregator that combines weighted signals from all strategies.\n\n" +
      "All strategies inherit from BaseStrategy in bot/strategies/base_strategy.py.",
  },

  // ===== Account / Progress =====
  {
    keywords: ["progress", "10k", "equity", "account", "portfolio", "buying power", "balance"],
    reply: (live) => {
      if (!live.account) return "I couldn't fetch account data right now. Try again in a moment.";
      const a = live.account;
      return (
        `Account status:\n` +
        `  Equity: $${a.equity.toFixed(2)}\n` +
        `  Buying power: $${a.buying_power.toFixed(2)}\n` +
        `  Progress to $10K: ${a.progress}%\n\n` +
        `Goal: grow this paper-trading account to $10,000 through disciplined algorithmic trading.`
      );
    },
  },

  // ===== Config / Parameters =====
  {
    keywords: ["config", "parameter", "setting", "tunable", "configurable", "threshold"],
    reply:
      "Configurable MSS parameters (all tunable):\n\n" +
      "  swing_lookback_N: 1 (default, ICT 3-candle) — range 1-5\n" +
      "  displacement_atr_mult: 1.5 — range 1.0-3.0\n" +
      "  displacement_body_ratio: 0.70 — range 0.50-0.90\n" +
      "  quality_accept_threshold: 65 — range 40-85\n" +
      "  htf_timeframe: 4H — range 1H-Daily\n" +
      "  session_weights: NY=1.0, London=0.95, Asia=0.70, Outside=0.60\n" +
      "  pdh_pdl_proximity_pct: 0.3% — range 0.1-1.0%\n" +
      "  fvg_min_gap_atr: 0.25 — range 0.1-0.5\n\n" +
      "Current bot uses: range >= 1.2x ATR, body >= 60%, wick <= 20%, lookback=5. " +
      "Target: migrate to the full ICT blueprint parameters above.",
  },

  // ===== Bonsai =====
  {
    keywords: ["bonsai"],
    reply:
      "Bonsai is the name of the MSS detection pipeline. It processes 1-min SPY bars through:\n\n" +
      "1. ATR(14) computation — measures current volatility\n" +
      "2. Swing detection — identifies control points (highs/lows)\n" +
      "3. Trend classification — HH/HL vs LH/LL sequence\n" +
      "4. MSS detection — break against trend with displacement\n" +
      "5. FVG check — confirms institutional conviction\n" +
      "6. Quality scoring — weighted 6-factor formula\n" +
      "7. Session weighting — adjusts for session reliability\n" +
      "8. Accept/reject gate — threshold at 65%\n\n" +
      "Named Bonsai because like pruning a bonsai tree, the pipeline carefully trims noise to reveal clean structure.",
  },

  // ===== Order Block =====
  {
    keywords: ["order block", "ob", "entry"],
    reply:
      "Order Block (OB) — the last opposing candle before a displacement move:\n\n" +
      "Bullish OB: the last bearish (red) candle before a bullish displacement\n" +
      "Bearish OB: the last bullish (green) candle before a bearish displacement\n\n" +
      "After an MSS is confirmed, price often retraces back to the OB or FVG zone. " +
      "This retrace is the ideal entry point — you're entering with institutional order flow.\n\n" +
      "Entry logic: wait for MSS -> identify FVG/OB zone -> enter on retrace into that zone -> " +
      "stop-loss below/above the MSS origin -> target the next key level.\n\n" +
      "The bot provides analysis to assist human trading decisions via OANDA.",
  },

  // ===== What do you know / help =====
  {
    keywords: ["what do you know", "help", "what can you", "topics"],
    reply:
      "I understand the ICT MSS (Market Structure Shift) framework inside and out:\n\n" +
      "Core concepts:\n" +
      "  - Swing highs/lows (ICT 3-candle definition)\n" +
      "  - Trend classification (HH/HL vs LH/LL)\n" +
      "  - MSS vs BOS vs CHoCH vs Liquidity Sweep\n" +
      "  - Displacement (ATR-relative + body-to-range ratio)\n" +
      "  - Fair Value Gaps (FVG)\n" +
      "  - Quality scoring (6-factor weighted formula)\n\n" +
      "Context:\n" +
      "  - Session windows and reliability weighting\n" +
      "  - Multi-timeframe confirmation (HTF alignment)\n" +
      "  - PDH/PDL confluence\n" +
      "  - Order Blocks and entry logic\n\n" +
      "Bot internals:\n" +
      "  - SMA Crossover strategy (10/30)\n" +
      "  - Risk rules (2% per trade, 5 positions, 5% daily limit)\n" +
      "  - Live MSS events, session levels, account progress\n\n" +
      "Ask me anything specific!",
  },
];

const FALLBACK =
  "I understand the ICT MSS framework — ask me about:\n\n" +
  "- What is MSS? (and how it differs from BOS, CHoCH, sweeps)\n" +
  "- Swing highs/lows (ICT 3-candle definition)\n" +
  "- Displacement rules (ATR + body ratio checks)\n" +
  "- Fair Value Gaps (FVG)\n" +
  "- Liquidity sweeps vs real breaks\n" +
  "- Quality scoring (6-factor formula)\n" +
  "- Trend classification (HH/HL vs LH/LL)\n" +
  "- Session weighting and multi-timeframe\n" +
  "- PDH/PDL confluence\n" +
  "- Live MSS events and account progress\n\n" +
  "Try one of these!";

// ---------------------------------------------------------------------------
// Live data fetcher
// ---------------------------------------------------------------------------

async function fetchLiveData(baseUrl: string): Promise<LiveData> {
  const results = await Promise.allSettled([
    fetch(`${baseUrl}/api/bot/mss`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    fetch(`${baseUrl}/api/bot/status`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
    fetch(`${baseUrl}/api/account`, { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)),
  ]);

  const mssRaw = results[0].status === "fulfilled" ? results[0].value : null;
  const statusRaw = results[1].status === "fulfilled" ? results[1].value : null;
  const accountRaw = results[2].status === "fulfilled" ? results[2].value : null;

  return {
    mss: mssRaw
      ? {
          symbol: mssRaw.symbol,
          date: mssRaw.date,
          total_mss: mssRaw.total_mss,
          accepted: mssRaw.accepted,
          rejected: mssRaw.rejected,
          atr: mssRaw.atr,
          control_points: mssRaw.control_points,
          avg_displacement_quality: mssRaw.avg_displacement_quality,
          pdh: mssRaw.pdh,
          pdl: mssRaw.pdl,
          events: mssRaw.events ?? [],
        }
      : null,
    status: statusRaw
      ? {
          current_session: statusRaw.current_session ?? null,
          sessions: statusRaw.sessions ?? [],
          daily: statusRaw.daily ?? null,
        }
      : null,
    account: accountRaw
      ? {
          equity: parseFloat(accountRaw.equity ?? "0"),
          buying_power: parseFloat(accountRaw.buying_power ?? "0"),
          progress: Math.round((parseFloat(accountRaw.equity ?? "0") / 10000) * 1000) / 10,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Keyword matcher
// ---------------------------------------------------------------------------

function findReply(input: string, live: LiveData): string {
  const lower = input.toLowerCase();

  // Score each entry: sum keyword matches, weighted by keyword length (longer = more specific = better)
  let bestEntry: KnowledgeEntry | null = null;
  let bestScore = 0;

  for (const entry of KNOWLEDGE) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) {
        score += kw.length; // longer keywords = more specific match
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestEntry = entry;
    }
  }

  if (bestEntry && bestScore > 0) {
    return typeof bestEntry.reply === "function" ? bestEntry.reply(live) : bestEntry.reply;
  }

  return FALLBACK;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  try {
    const { messages } = await req.json();

    if (!Array.isArray(messages) || messages.length === 0) {
      return NextResponse.json({ error: "messages array required" }, { status: 400 });
    }

    const lastMessage = messages[messages.length - 1];
    const userInput = typeof lastMessage.content === "string" ? lastMessage.content : "";

    if (!userInput.trim()) {
      return NextResponse.json({ reply: FALLBACK });
    }

    const proto = req.headers.get("x-forwarded-proto") ?? "http";
    const host = req.headers.get("host") ?? "localhost:3000";
    const baseUrl = `${proto}://${host}`;

    const live = await fetchLiveData(baseUrl);
    const reply = findReply(userInput, live);
    return NextResponse.json({ reply });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: `Chat failed: ${message}` }, { status: 500 });
  }
}
