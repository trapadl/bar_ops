import { NextResponse } from "next/server";
import { sanitizeConfig } from "@/lib/config";
import { getServerConfig, setServerConfig } from "@/lib/serverConfigStore";
import { AppConfig } from "@/lib/types";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(getServerConfig(), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function PUT(request: Request): Promise<NextResponse> {
  const payload = (await request.json()) as Partial<AppConfig>;
  const nextConfig = sanitizeConfig(payload);
  const saved = setServerConfig(nextConfig);
  return NextResponse.json(saved);
}
