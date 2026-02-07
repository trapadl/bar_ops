import { NextResponse } from "next/server";

export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      status: "mocked",
      message:
        "Backfill is stubbed in Phase 1. Replace with Square/Deputy sync + D1 persistence in Phase 2.",
      generatedAtIso: new Date().toISOString(),
    },
    {
      status: 202,
    },
  );
}
