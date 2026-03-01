"use client";

import { useRouter } from "next/navigation";
import { type PathwayData } from "@/lib/hooks/use-pathway";
import { type Instrument, INSTRUMENTS, getInstrument, formatInstrumentPrice } from "@/lib/constants";
import { ArrowUp, ArrowDown, TrendingUp, Shield, Gem } from "lucide-react";
import { cn } from "@/lib/utils";

function formatPrice(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

/* ── Instrument Icon ──────────────────────────────────────────────── */
function InstrumentIcon({ icon, flag }: { icon: Instrument["icon"]; flag: string | null }) {
  if (flag) return <span className="text-lg">{flag}</span>;
  switch (icon) {
    case "trending": return <TrendingUp className="h-5 w-5 text-white/70" />;
    case "badge": return <Shield className="h-5 w-5 text-white/70" />;
    case "gold": return <Gem className="h-5 w-5 text-yellow-200/80" />;
    case "silver": return <Gem className="h-5 w-5 text-zinc-200/80" />;
    default: return <TrendingUp className="h-5 w-5 text-white/70" />;
  }
}

/* ── Live Candle SVG ──────────────────────────────────────────────── */
function LiveCandle({ candle }: { candle: PathwayData["liveCandle"] }) {
  if (!candle || candle.open === 0) return null;

  const isGreen = candle.close >= candle.open;
  const color = isGreen ? "#10b981" : "#ef4444";

  const range = candle.high - candle.low || 1;
  const bodyTop = Math.max(candle.open, candle.close);
  const bodyBot = Math.min(candle.open, candle.close);

  const pad = 8;
  const h = 110;
  const toY = (price: number) => pad + ((candle.high - price) / range) * h;

  const wickX = 30;
  const bodyW = 24;

  return (
    <svg width="60" height="130" viewBox="0 0 60 130" className="flex-shrink-0">
      <line x1={wickX} y1={toY(candle.high)} x2={wickX} y2={toY(bodyTop)} stroke={color} strokeWidth="2" />
      <rect
        x={wickX - bodyW / 2}
        y={toY(bodyTop)}
        width={bodyW}
        height={Math.max(toY(bodyBot) - toY(bodyTop), 3)}
        fill={color}
        rx="2"
      />
      <line x1={wickX} y1={toY(bodyBot)} x2={wickX} y2={toY(candle.low)} stroke={color} strokeWidth="2" />
    </svg>
  );
}

/* ── Weekly Intraday Line Chart ───────────────────────────────────── */
function WeekChart({ weekLine, dayLabels }: { weekLine: PathwayData["weekLine"]; dayLabels: PathwayData["dayLabels"] }) {
  if (!weekLine || weekLine.length < 2) return null;

  const w = 440;
  const h = 80;
  const pad = { top: 6, bottom: 18, left: 4, right: 4 };
  const chartW = w - pad.left - pad.right;
  const chartH = h - pad.top - pad.bottom;

  const prices = weekLine.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;

  const points = weekLine.map((p, i) => ({
    x: pad.left + (i / (weekLine.length - 1)) * chartW,
    y: pad.top + ((max - p.price) / range) * chartH,
  }));

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
  const fillPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${(pad.top + chartH).toFixed(1)} L ${points[0].x.toFixed(1)} ${(pad.top + chartH).toFixed(1)} Z`;

  const currentDayIdx = dayLabels.length > 0 ? dayLabels[dayLabels.length - 1].index : -1;
  const currentDayX = currentDayIdx >= 0 ? pad.left + (currentDayIdx / (weekLine.length - 1)) * chartW : -1;

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="none">
      <defs>
        <linearGradient id="weekLineFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="hsl(210, 70%, 55%)" stopOpacity="0.25" />
          <stop offset="100%" stopColor="hsl(210, 70%, 55%)" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {currentDayX > 0 && (
        <rect x={currentDayX - 3} y={pad.top} width={6} height={chartH} fill="hsl(38, 80%, 55%)" rx="3" opacity="0.5" />
      )}

      <path d={fillPath} fill="url(#weekLineFill)" />
      <path d={linePath} fill="none" stroke="hsl(210, 70%, 55%)" strokeWidth="1.5" />

      {dayLabels.map((dl, i) => {
        const x = pad.left + (dl.index / (weekLine.length - 1)) * chartW;
        return (
          <text key={i} x={x} y={h - 2} textAnchor="start" className="fill-muted-foreground" fontSize="9" fontFamily="inherit">
            {dl.label}
          </text>
        );
      })}
    </svg>
  );
}

/* ── Strategy Score Ring ──────────────────────────────────────────── */
function ScoreRing({ score }: { score: number }) {
  const size = 64;
  const strokeWidth = 5;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (score / 100) * circumference;

  const color =
    score >= 70 ? "hsl(210, 70%, 55%)" :
    score >= 40 ? "hsl(210, 50%, 45%)" :
    "hsl(0, 60%, 55%)";

  return (
    <div className="relative flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full bg-card border border-border" />
      <svg width={size} height={size} className="-rotate-90 relative z-10">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="hsl(225, 30%, 20%)" strokeWidth={strokeWidth} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={circumference - progress}
          strokeLinecap="round"
        />
      </svg>
      <span className="absolute text-base font-bold text-blue-400 z-20">{score}</span>
    </div>
  );
}

/* ── Loading Skeleton ─────────────────────────────────────────────── */
export function PathwaySkeleton() {
  return (
    <div className="rounded-2xl bg-card border border-border overflow-hidden animate-pulse w-full">
      <div className="h-10 bg-blue-600/20" />
      <div className="p-5 space-y-4">
        <div className="h-8 w-40 bg-border/50 rounded" />
        <div className="h-4 w-24 bg-border/50 rounded" />
        <div className="flex gap-2">
          <div className="h-6 w-20 bg-border/50 rounded-full" />
          <div className="h-6 w-16 bg-border/50 rounded-full" />
          <div className="h-6 w-10 bg-border/50 rounded-full" />
        </div>
        <div className="h-24 bg-border/50 rounded" />
        <div className="h-16 bg-border/50 rounded" />
      </div>
    </div>
  );
}

/* ── Main Pathway Card ────────────────────────────────────────────── */
export function PathwayCard({ data }: { data: PathwayData }) {
  const router = useRouter();
  const instrument = getInstrument(data.symbol);
  const inst = instrument ?? INSTRUMENTS[0];

  const { accountEquity, displayPrice, priceChangePct, liveCandle, bias, marketState, confidenceRatio, targetLiquidity, strategyScore, weekLine, dayLabels } = data;
  const isPositive = priceChangePct >= 0;

  return (
    <div
      onClick={() => router.push(`/market?symbol=${data.symbol}`)}
      className="rounded-2xl bg-card border border-border overflow-hidden w-full cursor-pointer hover:border-blue-500/50 transition-colors">
      {/* 1. Header Strip */}
      <div className={cn("bg-gradient-to-r px-5 py-2.5 flex items-center justify-between", inst.headerGradient)}>
        <div className="flex items-center gap-2">
          <InstrumentIcon icon={inst.icon} flag={inst.flag} />
          <span className={cn("text-base font-bold tracking-wide", inst.headerText)}>
            {inst.displayName}
          </span>
        </div>
        <span className={cn("text-xs font-semibold opacity-70", inst.headerText)}>{inst.shortName}</span>
      </div>

      <div className="p-5 space-y-4">
        {/* 2. Account Equity + 3. Live Price */}
        <div className="flex items-start justify-between">
          <p className="text-3xl font-bold text-white tracking-tight">
            {formatPrice(accountEquity)}
          </p>
          <div className="text-right">
            <div className={cn("flex items-center gap-1 justify-end text-lg font-bold", isPositive ? "text-success" : "text-loss")}>
              {isPositive ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
              {formatPct(priceChangePct)}
            </div>
            <p className={cn("text-sm font-medium", isPositive ? "text-success/80" : "text-loss/80")}>
              ${formatInstrumentPrice(displayPrice, data.symbol)}
            </p>
          </div>
        </div>

        {/* 4. Bias + Market State + Confidence */}
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold border",
              bias === "BULLISH" && "bg-success/10 text-success border-success/30",
              bias === "BEARISH" && "bg-loss/10 text-loss border-loss/30",
              bias === "NEUTRAL" && "bg-muted text-muted-foreground border-border"
            )}
          >
            {bias === "BULLISH" && <ArrowUp className="h-3 w-3" />}
            {bias === "BEARISH" && <ArrowDown className="h-3 w-3" />}
            {bias}
          </span>
          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-white/5 text-muted-foreground border border-border">
            {marketState}
          </span>
          <span className="px-2.5 py-1 rounded-full text-xs font-bold bg-orange-500/10 text-orange-400 border border-orange-500/30">
            {confidenceRatio}
          </span>
        </div>

        {/* 5. Target Liquidity + 6. Live Candle */}
        <div className="flex items-center justify-between">
          <div className="flex-1">
            <p className="text-xs text-muted-foreground mb-1">Target liquidity:</p>
            <div className="flex items-center gap-1.5">
              <span className="text-base font-bold text-white">{targetLiquidity.label}</span>
              {targetLiquidity.direction === "up" ? (
                <ArrowUp className="h-4 w-4 text-success" />
              ) : (
                <ArrowDown className="h-4 w-4 text-loss" />
              )}
            </div>
          </div>

          <LiveCandle candle={liveCandle} />
        </div>

        {/* 8. Weekly Intraday Chart + 9. Strategy Score */}
        <div className="flex items-end gap-3 -mx-1">
          <ScoreRing score={strategyScore} />
          <div className="flex-1 min-w-0 overflow-hidden">
            <WeekChart weekLine={weekLine} dayLabels={dayLabels} />
          </div>
        </div>

        {/* Market status indicator */}
        {!data.marketOpen && (
          <p className="text-[10px] text-muted-foreground/50 text-center">
            Market closed — showing last trading session
          </p>
        )}
      </div>
    </div>
  );
}
