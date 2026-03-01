"use client";

import { PathwayCard, PathwaySkeleton } from "@/components/cards/pathway-card";
import { useAllPathways } from "@/lib/hooks/use-pathway";
import { INSTRUMENTS } from "@/lib/constants";

export default function DashboardPage() {
  const { pathways, isLoading } = useAllPathways();

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {isLoading || pathways.length === 0
          ? INSTRUMENTS.map((inst) => <PathwaySkeleton key={inst.symbol} />)
          : pathways.map((pw) => <PathwayCard key={pw.symbol} data={pw} />)
        }
      </div>
    </div>
  );
}
