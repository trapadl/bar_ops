import { AppConfig, SquareEnvironment } from "@/lib/types";

const ENV_KEYS = {
  squareAccessToken: ["SQUARE_ACCESS_TOKEN", "BAROPS_SQUARE_ACCESS_TOKEN"],
  squareLocationId: ["SQUARE_LOCATION_ID", "BAROPS_SQUARE_LOCATION_ID"],
  squareEnvironment: ["SQUARE_ENVIRONMENT", "BAROPS_SQUARE_ENVIRONMENT"],
  deputyAccessToken: ["DEPUTY_ACCESS_TOKEN", "BAROPS_DEPUTY_ACCESS_TOKEN"],
  deputyBaseUrl: ["DEPUTY_BASE_URL", "BAROPS_DEPUTY_BASE_URL"],
} as const;

interface RealtimeEnvConfigResult {
  config: AppConfig;
  missing: string[];
}

interface SquareRuntimeConfigResult {
  environment: SquareEnvironment;
  accessToken: string;
  locationId: string;
  missing: string[];
}

function getFirstSetEnv(keys: readonly string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return "";
}

function sanitizeOrigin(value: string): string {
  if (!value) {
    return "";
  }

  try {
    const parsed = new URL(value);
    return parsed.origin;
  } catch {
    return "";
  }
}

function resolveSquareEnvironment(): SquareEnvironment {
  const raw = getFirstSetEnv(ENV_KEYS.squareEnvironment).toLowerCase();
  return raw === "sandbox" ? "sandbox" : "production";
}

export function resolveSquareRuntimeConfig(): SquareRuntimeConfigResult {
  const accessToken = getFirstSetEnv(ENV_KEYS.squareAccessToken);
  const locationId = getFirstSetEnv(ENV_KEYS.squareLocationId);
  const missing: string[] = [];

  if (!accessToken) {
    missing.push(ENV_KEYS.squareAccessToken[0]);
  }
  if (!locationId) {
    missing.push(ENV_KEYS.squareLocationId[0]);
  }

  return {
    environment: resolveSquareEnvironment(),
    accessToken,
    locationId,
    missing,
  };
}

export function withRealtimeEnvConfig(baseConfig: AppConfig): RealtimeEnvConfigResult {
  const squareRuntime = resolveSquareRuntimeConfig();
  const deputyAccessToken = getFirstSetEnv(ENV_KEYS.deputyAccessToken);
  const deputyBaseUrl = sanitizeOrigin(getFirstSetEnv(ENV_KEYS.deputyBaseUrl));

  const missing: string[] = [...squareRuntime.missing];
  if (!deputyAccessToken) {
    missing.push(ENV_KEYS.deputyAccessToken[0]);
  }
  if (!deputyBaseUrl) {
    missing.push(ENV_KEYS.deputyBaseUrl[0]);
  }

  return {
    config: {
      ...baseConfig,
      square: {
        environment: squareRuntime.environment,
        accessToken: squareRuntime.accessToken,
        locationId: squareRuntime.locationId,
      },
      deputy: {
        accessToken: deputyAccessToken,
        baseUrl: deputyBaseUrl,
      },
    },
    missing,
  };
}
