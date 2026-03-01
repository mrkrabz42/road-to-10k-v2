"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Brain,
  Activity,
  Globe,
  Bell,
  CandlestickChart,
  Settings,
  ChevronsLeft,
  ChevronsRight,
  X,
} from "lucide-react";
import { useSidebar } from "@/lib/context/sidebar-context";
import { NAV_ITEMS } from "@/lib/constants";
import { cn } from "@/lib/utils";

const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
  LayoutDashboard,
  Briefcase,
  ArrowLeftRight,
  Brain,
  Activity,
  Globe,
  Bell,
  CandlestickChart,
  Settings,
};

export function Sidebar() {
  const pathname = usePathname();
  const { collapsed, toggleSidebar, mobileOpen, setMobileOpen } = useSidebar();

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname.startsWith(href);
  };

  const navContent = (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className={cn(
        "flex items-center gap-3 px-4 py-5 border-b border-sidebar-border",
        collapsed && "justify-center px-2"
      )}>
        <Image
          src="/logo.png"
          alt="The World Is Yours"
          width={collapsed ? 36 : 48}
          height={collapsed ? 36 : 48}
          className="flex-shrink-0 rounded-md object-contain"
          priority
        />
        {!collapsed && (
          <div className="overflow-hidden">
            <h1 className="text-sm font-bold text-white whitespace-nowrap tracking-widest">THE WORLD IS YOURS</h1>
            <span className="text-[10px] text-pink font-medium">ANALYSIS MODE</span>
          </div>
        )}
        {/* Mobile close button */}
        <button
          onClick={() => setMobileOpen(false)}
          className="ml-auto lg:hidden text-muted-foreground hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-4 space-y-1 px-2">
        {NAV_ITEMS.map((item) => {
          const Icon = ICON_MAP[item.icon];
          const active = isActive(item.href);
          return (
            <Link
              key={item.key}
              href={item.href}
              onClick={() => setMobileOpen(false)}
              className={cn(
                "flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-all duration-200 group relative",
                active
                  ? "bg-pink/10 text-white"
                  : "text-muted-foreground hover:text-white hover:bg-white/5",
                collapsed && "justify-center px-2"
              )}
            >
              {active && (
                <span className="absolute left-0 top-1/2 -translate-y-1/2 w-[3px] h-5 bg-pink rounded-r-full" />
              )}
              {Icon && <Icon className={cn("h-4 w-4 flex-shrink-0", active && "text-pink")} />}
              {!collapsed && <span>{item.label}</span>}
            </Link>
          );
        })}
      </nav>

      {/* Collapse toggle — desktop only */}
      <div className="hidden lg:block border-t border-sidebar-border p-2">
        <button
          onClick={toggleSidebar}
          className="flex items-center gap-2 w-full px-3 py-2 text-sm text-muted-foreground hover:text-white hover:bg-white/5 rounded-lg transition-colors"
        >
          {collapsed ? (
            <ChevronsRight className="h-4 w-4 mx-auto" />
          ) : (
            <>
              <ChevronsLeft className="h-4 w-4" />
              <span>Collapse</span>
            </>
          )}
        </button>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Mobile sidebar */}
      <aside
        className={cn(
          "fixed top-0 left-0 h-full w-[240px] bg-sidebar z-50 lg:hidden transition-transform duration-300",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {navContent}
      </aside>

      {/* Desktop sidebar */}
      <aside
        className={cn(
          "hidden lg:flex flex-col h-screen bg-sidebar border-r border-sidebar-border sticky top-0 transition-all duration-300 flex-shrink-0",
          collapsed ? "w-[64px]" : "w-[240px]"
        )}
      >
        {navContent}
      </aside>
    </>
  );
}
