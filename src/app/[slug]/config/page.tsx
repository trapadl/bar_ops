"use client";

import Link from "next/link";
import { Fragment, SetStateAction, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { DAY_KEYS, DAY_LABELS, cloneConfig, DEFAULT_CONFIG } from "@/lib/config";
import { AppConfig, DayKey } from "@/lib/types";
import { useConfig } from "@/lib/useConfig";

function toPositiveNumber(value: string, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, parsed);
}

function areConfigsEqual(left: AppConfig, right: AppConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

interface OpenTableOption {
  label: string;
  orderCount: number;
  totalCents: number;
}

interface OpenTablesErrorState {
  status: number;
  message: string;
  debugCode: string | null;
  missing: string[];
}

interface ConfigEditorProps {
  slug: string;
  config: AppConfig;
  setConfig: (value: SetStateAction<AppConfig>) => void;
  resetConfig: () => void;
}

function ConfigEditor({
  slug,
  config,
  setConfig,
  resetConfig,
}: ConfigEditorProps): React.JSX.Element {
  const [draftConfig, setDraftConfig] = useState<AppConfig>(() => cloneConfig(config));
  const [saveMessage, setSaveMessage] = useState<string>("");
  const [openTableOptions, setOpenTableOptions] = useState<OpenTableOption[]>([]);
  const [openTablesLoading, setOpenTablesLoading] = useState<boolean>(false);
  const [openTablesError, setOpenTablesError] = useState<OpenTablesErrorState | null>(
    null,
  );

  const isDirty = useMemo(
    () => !areConfigsEqual(draftConfig, config),
    [draftConfig, config],
  );

  const updateDraft = (updater: (current: AppConfig) => AppConfig): void => {
    setDraftConfig((previous) => updater(cloneConfig(previous)));
    setSaveMessage("");
  };

  const loadOpenTableOptions = useCallback(async (): Promise<void> => {
    setOpenTablesLoading(true);

    try {
      const response = await fetch("/api/open-tables", {
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      });

      const payload = (await response.json()) as unknown;

      if (!response.ok) {
        const objectPayload =
          payload && typeof payload === "object"
            ? (payload as {
                error?: unknown;
                message?: unknown;
                debugCode?: unknown;
                missing?: unknown;
              })
            : null;

        const message =
          typeof objectPayload?.message === "string"
            ? objectPayload.message
            : typeof objectPayload?.error === "string"
              ? objectPayload.error
              : "Open-table discovery failed.";

        const missing = Array.isArray(objectPayload?.missing)
          ? objectPayload.missing.filter((entry): entry is string => typeof entry === "string")
          : [];

        setOpenTablesError({
          status: response.status,
          message,
          debugCode:
            typeof objectPayload?.debugCode === "string"
              ? objectPayload.debugCode
              : null,
          missing,
        });
        setOpenTableOptions([]);
        return;
      }

      const objectPayload =
        payload && typeof payload === "object"
          ? (payload as { openTables?: unknown })
          : null;

      const openTables = Array.isArray(objectPayload?.openTables)
        ? objectPayload.openTables
        : [];

      const normalizedOptions = openTables
        .map((entry) => {
          const objectEntry =
            entry && typeof entry === "object"
              ? (entry as {
                  label?: unknown;
                  orderCount?: unknown;
                  totalCents?: unknown;
                })
              : null;

          if (!objectEntry || typeof objectEntry.label !== "string") {
            return null;
          }

          const label = objectEntry.label.trim().toLowerCase();
          if (!label) {
            return null;
          }

          return {
            label,
            orderCount:
              typeof objectEntry.orderCount === "number"
                ? Math.max(1, Math.round(objectEntry.orderCount))
                : 1,
            totalCents:
              typeof objectEntry.totalCents === "number"
                ? Math.max(0, Math.round(objectEntry.totalCents))
                : 0,
          };
        })
        .filter((entry): entry is OpenTableOption => entry !== null)
        .sort((left, right) => left.label.localeCompare(right.label));

      setOpenTableOptions(normalizedOptions);
      setOpenTablesError(null);
    } catch {
      setOpenTablesError({
        status: 0,
        message: "Unable to load open tables from Square.",
        debugCode: "CLIENT-NETWORK",
        missing: [],
      });
      setOpenTableOptions([]);
    } finally {
      setOpenTablesLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadOpenTableOptions();
  }, [loadOpenTableOptions]);

  const openTableOptionByLabel = useMemo(() => {
    const map = new Map<string, OpenTableOption>();
    for (const option of openTableOptions) {
      map.set(option.label, option);
    }
    return map;
  }, [openTableOptions]);

  const selectableExcludedLabels = useMemo(() => {
    const labels = new Set<string>();

    for (const label of draftConfig.excludedOpenOrderLabels) {
      const cleaned = label.trim().toLowerCase();
      if (cleaned) {
        labels.add(cleaned);
      }
    }

    for (const option of openTableOptions) {
      labels.add(option.label);
    }

    return Array.from(labels).sort((left, right) => left.localeCompare(right));
  }, [draftConfig.excludedOpenOrderLabels, openTableOptions]);

  const toggleExcludedLabel = (label: string, checked: boolean): void => {
    updateDraft((previous) => {
      const next = new Set(previous.excludedOpenOrderLabels.map((item) => item.toLowerCase()));

      if (checked) {
        next.add(label);
      } else {
        next.delete(label);
      }

      return {
        ...previous,
        excludedOpenOrderLabels: Array.from(next).sort((left, right) =>
          left.localeCompare(right),
        ),
      };
    });
  };

  const saveChanges = (): void => {
    setConfig(cloneConfig(draftConfig));
    setSaveMessage("Saved");
  };

  const discardChanges = (): void => {
    setDraftConfig(cloneConfig(config));
    setSaveMessage("Reverted to last saved values");
  };

  const resetAll = (): void => {
    resetConfig();
    setDraftConfig(cloneConfig(DEFAULT_CONFIG));
    setSaveMessage("Defaults restored");
  };

  return (
    <section className="grid-cards config-grid">
      <article className="card">
        <h2 className="card-title">Store Settings</h2>
        <p className="muted">Edit values, then click Save Changes.</p>

        <div className="form-grid">
          <label className="field">
            <span>Store Name</span>
            <input
              value={draftConfig.storeName}
              onChange={(event) =>
                updateDraft((previous) => ({
                  ...previous,
                  storeName: event.target.value,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Timezone</span>
            <input
              value={draftConfig.timezone}
              onChange={(event) =>
                updateDraft((previous) => ({
                  ...previous,
                  timezone: event.target.value,
                }))
              }
            />
          </label>

          <label className="field">
            <span>Live Refresh Interval (seconds)</span>
            <input
              type="number"
              min={15}
              max={900}
              value={draftConfig.refreshIntervalSeconds}
              onChange={(event) =>
                updateDraft((previous) => ({
                  ...previous,
                  refreshIntervalSeconds: toPositiveNumber(event.target.value, 15),
                }))
              }
            />
          </label>

          <label className="field">
            <span>Average Bill Length (mins)</span>
            <input
              type="number"
              min={1}
              max={240}
              value={draftConfig.averageBillLengthMinutes}
              onChange={(event) =>
                updateDraft((previous) => ({
                  ...previous,
                  averageBillLengthMinutes: toPositiveNumber(event.target.value, 1),
                }))
              }
            />
          </label>

          <label className="field">
            <span>Average Hourly Rate (AUD)</span>
            <input
              type="number"
              min={5}
              max={200}
              step={0.5}
              value={draftConfig.averageHourlyRate}
              onChange={(event) =>
                updateDraft((previous) => ({
                  ...previous,
                  averageHourlyRate: toPositiveNumber(event.target.value, 5),
                }))
              }
            />
          </label>

          <label className="field">
            <span>Excluded Debtor/Open Table Labels</span>
            <p className="muted">
              Select currently open tables to exclude carryover from adjusted revenue and
              projection math.
            </p>
            <div className="actions">
              <button
                className="button-secondary"
                type="button"
                onClick={() => void loadOpenTableOptions()}
                disabled={openTablesLoading}
              >
                {openTablesLoading ? "Refreshing..." : "Refresh Open Tables"}
              </button>
              <button
                className="button-secondary"
                type="button"
                onClick={() =>
                  updateDraft((previous) => ({
                    ...previous,
                    excludedOpenOrderLabels: [],
                  }))
                }
                disabled={draftConfig.excludedOpenOrderLabels.length === 0}
              >
                Clear Exclusions
              </button>
            </div>
            {openTablesError ? (
              <p className="warn">
                {openTablesError.message}{" "}
                <code className="debug-code">{openTablesError.debugCode ?? "N/A"}</code>
              </p>
            ) : null}
            {openTablesError && openTablesError.missing.length > 0 ? (
              <p className="muted">Missing: {openTablesError.missing.join(", ")}</p>
            ) : null}
            <div className="open-table-picker" role="group" aria-label="Excluded open tables">
              {selectableExcludedLabels.length === 0 ? (
                <p className="muted">No currently open tables found.</p>
              ) : (
                selectableExcludedLabels.map((label) => {
                  const isChecked = draftConfig.excludedOpenOrderLabels.includes(label);
                  const option = openTableOptionByLabel.get(label);

                  return (
                    <label key={label} className="open-table-option">
                      <input
                        className="open-table-checkbox"
                        type="checkbox"
                        checked={isChecked}
                        onChange={(event) => toggleExcludedLabel(label, event.target.checked)}
                      />
                      <span>
                        {label}
                        {option
                          ? ` (${option.orderCount} open, $${(option.totalCents / 100).toFixed(2)})`
                          : " (saved, not currently open)"}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </label>
        </div>
      </article>

      <article className="card">
        <h2 className="card-title">Realtime Integrations</h2>
        <p className="muted">
          Square and Deputy credentials are server-only. Set them in environment
          variables (local <code>.env.local</code> or Vercel Project Settings). They are
          never saved in browser storage.
        </p>

        <div className="form-grid">
          <div className="field">
            <span>Default Dashboard Source</span>
            <div className="source-toggle" role="group" aria-label="Default data source">
              <button
                type="button"
                className={`source-button ${draftConfig.dataSourceMode === "sample" ? "active" : ""}`}
                onClick={() =>
                  updateDraft((previous) => ({
                    ...previous,
                    dataSourceMode: "sample",
                  }))
                }
              >
                Sample
              </button>
              <button
                type="button"
                className={`source-button ${draftConfig.dataSourceMode === "realtime" ? "active" : ""}`}
                onClick={() =>
                  updateDraft((previous) => ({
                    ...previous,
                    dataSourceMode: "realtime",
                  }))
                }
              >
                Realtime (Square + Deputy)
              </button>
            </div>
          </div>

          <div className="field">
            <span>Required Environment Variables</span>
            <p className="muted">
              <code>SQUARE_ACCESS_TOKEN</code>
              <br />
              <code>SQUARE_LOCATION_ID</code>
              <br />
              <code>DEPUTY_ACCESS_TOKEN</code>
              <br />
              <code>DEPUTY_BASE_URL</code>
              <br />
              <code>SQUARE_ENVIRONMENT</code> (optional: <code>production</code> or{" "}
              <code>sandbox</code>)
            </p>
          </div>
        </div>

        <div className="api-help">
          <p className="muted">Reference docs:</p>
          <p className="muted">
            Square access tokens:{" "}
            <a
              href="https://developer.squareup.com/docs/build-basics/access-tokens"
              target="_blank"
              rel="noreferrer"
            >
              developer.squareup.com/docs/build-basics/access-tokens
            </a>
          </p>
          <p className="muted">
            Deputy API getting started:{" "}
            <a
              href="https://developer.deputy.com/docs/getting-started-with-the-deputy-api"
              target="_blank"
              rel="noreferrer"
            >
              developer.deputy.com/docs/getting-started-with-the-deputy-api
            </a>
          </p>
          <p className="muted">
            Square needs a Location ID (for example, <code>L...</code>) and not the
            Square Application ID (<code>sq0idp-...</code>).
          </p>
          <p className="muted">
            Deputy base URL should be the account origin only (for example,{" "}
            <code>https://your-company.au.deputy.com</code>).
          </p>
        </div>
      </article>

      <article className="card">
        <h2 className="card-title">Daily Operating Hours</h2>
        <p className="muted">Set opening/closing times or mark the day closed.</p>

        <div className="targets-table hours-table-closed">
          <div className="targets-head">Day</div>
          <div className="targets-head">Closed</div>
          <div className="targets-head">Opening</div>
          <div className="targets-head">Closing</div>

          {DAY_KEYS.map((dayKey: DayKey) => (
            <Fragment key={dayKey}>
              <div className="targets-day">{DAY_LABELS[dayKey]}</div>
              <div className="hours-closed-cell">
                <input
                  className="hours-closed-checkbox"
                  type="checkbox"
                  checked={draftConfig.dailyOperatingHours[dayKey].isClosed}
                  onChange={(event) =>
                    updateDraft((previous) => ({
                      ...previous,
                      dailyOperatingHours: {
                        ...previous.dailyOperatingHours,
                        [dayKey]: {
                          ...previous.dailyOperatingHours[dayKey],
                          isClosed: event.target.checked,
                        },
                      },
                    }))
                  }
                />
              </div>
              <div>
                <input
                  type="time"
                  disabled={draftConfig.dailyOperatingHours[dayKey].isClosed}
                  value={draftConfig.dailyOperatingHours[dayKey].openingTime}
                  onChange={(event) =>
                    updateDraft((previous) => ({
                      ...previous,
                      dailyOperatingHours: {
                        ...previous.dailyOperatingHours,
                        [dayKey]: {
                          ...previous.dailyOperatingHours[dayKey],
                          openingTime: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </div>
              <div>
                <input
                  type="time"
                  disabled={draftConfig.dailyOperatingHours[dayKey].isClosed}
                  value={draftConfig.dailyOperatingHours[dayKey].closingTime}
                  onChange={(event) =>
                    updateDraft((previous) => ({
                      ...previous,
                      dailyOperatingHours: {
                        ...previous.dailyOperatingHours,
                        [dayKey]: {
                          ...previous.dailyOperatingHours[dayKey],
                          closingTime: event.target.value,
                        },
                      },
                    }))
                  }
                />
              </div>
            </Fragment>
          ))}
        </div>
      </article>

      <article className="card">
        <h2 className="card-title">Daily Targets</h2>
        <p className="muted">
          Revenue targets are entered as dollars. Wage targets are percentages.
        </p>

        <div className="targets-table">
          <div className="targets-head">Day</div>
          <div className="targets-head">Revenue Target (AUD)</div>
          <div className="targets-head">Wage Target (%)</div>

          {DAY_KEYS.map((dayKey: DayKey) => (
            <Fragment key={dayKey}>
              <div className="targets-day">{DAY_LABELS[dayKey]}</div>
              <div>
                <input
                  type="number"
                  min={0}
                  value={Math.round(draftConfig.dailyTargets[dayKey].revenueTargetCents / 100)}
                  onChange={(event) =>
                    updateDraft((previous) => ({
                      ...previous,
                      dailyTargets: {
                        ...previous.dailyTargets,
                        [dayKey]: {
                          ...previous.dailyTargets[dayKey],
                          revenueTargetCents:
                            Math.round(toPositiveNumber(event.target.value, 0)) * 100,
                        },
                      },
                    }))
                  }
                />
              </div>
              <div>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={draftConfig.dailyTargets[dayKey].wageTargetPercent}
                  onChange={(event) =>
                    updateDraft((previous) => ({
                      ...previous,
                      dailyTargets: {
                        ...previous.dailyTargets,
                        [dayKey]: {
                          ...previous.dailyTargets[dayKey],
                          wageTargetPercent: toPositiveNumber(event.target.value, 0),
                        },
                      },
                    }))
                  }
                />
              </div>
            </Fragment>
          ))}
        </div>

        <div className="actions">
          <button
            className="button-primary"
            type="button"
            onClick={saveChanges}
            disabled={!isDirty}
          >
            Save Changes
          </button>
          <button
            className="button-secondary"
            type="button"
            onClick={discardChanges}
            disabled={!isDirty}
          >
            Discard
          </button>
          <button className="button-secondary" onClick={resetAll} type="button">
            Reset Defaults
          </button>
          <Link className="button-secondary" href={`/${slug}/dashboard`}>
            Return to Dashboard
          </Link>
          <span className="save-status">{saveMessage}</span>
        </div>
      </article>
    </section>
  );
}

export default function ConfigPage(): React.JSX.Element {
  const { slug } = useParams<{ slug: string }>();
  const { config, ready, setConfig, resetConfig } = useConfig();

  const configKey = useMemo(() => JSON.stringify(config), [config]);

  if (!ready) {
    return (
      <section className="grid-cards">
        <article className="card">
          <h2 className="card-title">Loading Configuration</h2>
          <p className="muted">Reading saved store settings...</p>
        </article>
      </section>
    );
  }

  return (
    <ConfigEditor
      key={configKey}
      slug={slug}
      config={config}
      setConfig={setConfig}
      resetConfig={resetConfig}
    />
  );
}
