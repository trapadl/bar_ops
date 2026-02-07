import { cloneConfig, DEFAULT_CONFIG, sanitizeConfig } from "@/lib/config";
import { AppConfig } from "@/lib/types";

let currentConfig: AppConfig = cloneConfig(DEFAULT_CONFIG);

export function getServerConfig(): AppConfig {
  return cloneConfig(currentConfig);
}

export function setServerConfig(input: AppConfig): AppConfig {
  currentConfig = sanitizeConfig(input);
  return cloneConfig(currentConfig);
}
