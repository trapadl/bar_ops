"use client";

import { useEffect } from "react";

export function ServiceWorkerRegister(): null {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      return;
    }

    if (process.env.NODE_ENV !== "production") {
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(registrations.map((registration) => registration.unregister())),
        )
        .catch(() => {});
      return;
    }

    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Ignore registration errors in local/dev browsers that block SW.
    });
  }, []);

  return null;
}
