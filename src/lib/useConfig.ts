"use client";

import { SetStateAction, useCallback, useSyncExternalStore } from "react";
import {
  cloneConfig,
  DEFAULT_CONFIG,
  loadConfigFromStorage,
  sanitizeConfig,
  saveConfigToStorage,
} from "@/lib/config";
import { AppConfig } from "@/lib/types";

interface UseConfigResult {
  config: AppConfig;
  ready: boolean;
  setConfig: (value: SetStateAction<AppConfig>) => void;
  resetConfig: () => void;
}

const SERVER_SNAPSHOT = sanitizeConfig(DEFAULT_CONFIG);
let clientSnapshot: AppConfig = SERVER_SNAPSHOT;
let clientSnapshotHash = JSON.stringify(clientSnapshot);
let clientInitialized = false;

const listeners = new Set<() => void>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setClientSnapshot(nextSnapshot: AppConfig): boolean {
  const nextHash = JSON.stringify(nextSnapshot);
  if (nextHash === clientSnapshotHash) {
    return false;
  }

  clientSnapshot = nextSnapshot;
  clientSnapshotHash = nextHash;
  return true;
}

function ensureClientInitialized(): void {
  if (typeof window === "undefined" || clientInitialized) {
    return;
  }

  clientInitialized = true;
  const loaded = loadConfigFromStorage();
  setClientSnapshot(loaded);
  // Persist sanitized config immediately so any legacy secret fields are removed.
  saveConfigToStorage(loaded);
  void pushConfigToServer(loaded);
}

function subscribeToConfig(onChange: () => void): () => void {
  if (typeof window === "undefined") {
    return () => {};
  }

  ensureClientInitialized();
  listeners.add(onChange);

  const handleStorage = (): void => {
    const loaded = loadConfigFromStorage();
    if (setClientSnapshot(loaded)) {
      emitChange();
    }
  };

  window.addEventListener("storage", handleStorage);

  return () => {
    listeners.delete(onChange);
    window.removeEventListener("storage", handleStorage);
  };
}

function getConfigSnapshot(): AppConfig {
  ensureClientInitialized();
  return clientSnapshot;
}

function getServerSnapshot(): AppConfig {
  return SERVER_SNAPSHOT;
}

async function pushConfigToServer(config: AppConfig): Promise<void> {
  try {
    await fetch("/api/config", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(config),
    });
  } catch {
    // Keep local config authoritative if the server cache is unavailable.
  }
}

export function useConfig(): UseConfigResult {
  const config = useSyncExternalStore(
    subscribeToConfig,
    getConfigSnapshot,
    getServerSnapshot,
  );

  const setConfig = useCallback((value: SetStateAction<AppConfig>) => {
    ensureClientInitialized();
    const previous = clientSnapshot;
    const nextConfig =
      typeof value === "function"
        ? (value as (previous: AppConfig) => AppConfig)(previous)
        : value;

    const sanitized = sanitizeConfig(nextConfig);
    if (setClientSnapshot(sanitized)) {
      saveConfigToStorage(sanitized);
      emitChange();
      void pushConfigToServer(sanitized);
    }
  }, []);

  const resetConfig = useCallback(
    () => setConfig(cloneConfig(DEFAULT_CONFIG)),
    [setConfig],
  );

  return {
    config,
    ready: true,
    setConfig,
    resetConfig,
  };
}
