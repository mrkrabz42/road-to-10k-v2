"use client";

import { Separator } from "@/components/ui/separator";
import { MarketClock } from "@/components/cards/market-clock";
import { MarketStatusCard } from "@/components/cards/market-status-card";
import { TimezoneSelector } from "./timezone-selector";
import { TIMEZONE_OPTIONS } from "@/lib/constants";
import type { TimezoneKey } from "@/lib/types";

export function RightPanel() {
  return (
    <aside className="hidden xl:flex flex-col w-[280px] border-l border-border bg-card/50 h-screen sticky top-0 overflow-y-auto flex-shrink-0">
      <div className="p-4 space-y-4">
        <MarketClock />

        <div className="flex justify-center">
          <TimezoneSelector />
        </div>

        <Separator className="bg-border" />

        <div className="space-y-2">
          <p className="text-xs text-muted-foreground font-medium uppercase tracking-wider">Exchanges</p>
          {TIMEZONE_OPTIONS.map((opt) => (
            <MarketStatusCard key={opt.key} exchangeKey={opt.key as TimezoneKey} />
          ))}
        </div>
      </div>
    </aside>
  );
}
