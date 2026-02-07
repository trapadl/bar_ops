import { NextResponse } from "next/server";
import { buildHistorySnapshot } from "@/lib/mockData";
import { getServerConfig } from "@/lib/serverConfigStore";

function parseDateFromQuery(url: string): Date {
  const searchParams = new URL(url).searchParams;
  const queryDate = searchParams.get("date");
  if (!queryDate) {
    return new Date();
  }

  const parsed = new Date(`${queryDate}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    return new Date();
  }

  return parsed;
}

export async function GET(request: Request): Promise<NextResponse> {
  const config = getServerConfig();
  const referenceDate = parseDateFromQuery(request.url);
  const payload = buildHistorySnapshot(config, referenceDate);

  return NextResponse.json(payload, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
