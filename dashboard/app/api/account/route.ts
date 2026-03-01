import { NextResponse } from "next/server";
import { fetchAccount } from "@/lib/oanda";

export async function GET() {
  try {
    const data = await fetchAccount();
    return NextResponse.json(data);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
