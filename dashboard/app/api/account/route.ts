import { NextResponse } from "next/server";
import { fetchTrading } from "@/lib/alpaca";

export async function GET() {
  try {
    const res = await fetchTrading("/account");
    if (!res.ok) {
      return NextResponse.json({ error: "Failed to fetch account" }, { status: res.status });
    }
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
