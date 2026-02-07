"use client";

import Link from "next/link";
import { Fragment, SetStateAction, useMemo, useState } from "react";
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

function parseLabelListInput(value: string): string[] {
  const unique = new Set<string>();
  const parts = value.split(/\r?\n|,/g);

  for (const part of parts) {
    const cleaned = part.trim().toLowerCase();
    if (!cleaned) {
      continue;
    }

    unique.add(cleaned);
    if (unique.size >= 20) {
      break;
    }
  }

  return Array.from(unique);
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

  const isDirty = useMemo(
    () => !areConfigsEqual(draftConfig, config),
    [draftConfig, config],
  );

  const updateDraft = (updater: (current: AppConfig) => AppConfig): void => {
    setDraftConfig((previous) => updater(cloneConfig(previous)));
    setSaveMessage("");
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
            <textarea
              rows={4}
              value={draftConfig.excludedOpenOrderLabels.join("\n")}
              onChange={(event) =>
                updateDraft((previous) => ({
                  ...previous,
                  excludedOpenOrderLabels: parseLabelListInput(event.target.value),
                }))
              }
              placeholder={"walkouts\nwastage\nmanagers"}
            />
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
