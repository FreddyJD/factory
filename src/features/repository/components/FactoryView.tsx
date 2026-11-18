import { lazy, Suspense, useState } from "react";
import { preview } from "../../../shared/api";
import type { Checkout, Inventory } from "../../../shared/types";
import type { Visualization } from "../../../shared/visualization";
import { Icon } from "../../../shared/components/Icon";
import type { FileActivity } from "../hooks/useFileActivity";
import type { ToolActivity } from "../hooks/useToolActivity";
import { SceneFeed } from "./SceneFeed";
import "./factory.css";

const FactoryScene = lazy(() => import("./FactoryScene"));

export function FactoryView({
  visualization,
  inventory,
  target,
  calls,
  activity,
  choose,
  openFiles,
  onSettings,
  connection,
  loading,
  error,
}: {
  visualization: Visualization;
  inventory?: Inventory;
  target?: Checkout;
  calls: ToolActivity[];
  activity: FileActivity[];
  choose: (id: string) => void;
  openFiles: () => void;
  onSettings: () => void;
  connection: "live" | "connecting" | "offline";
  loading: boolean;
  error?: string;
}) {
  const [paused, setPaused] = useState(false);
  const [feedOpen, setFeedOpen] = useState(true);
  const targets = inventory?.targets ?? [];
  return (
    <section
      className="factory-view"
      aria-label="Factory view"
      data-theme={visualization}
    >
      <div className="factory-stage">
        <div className="factory-stage-top">
          <span
            className="scene-connection"
            data-live={!preview && connection === "live"}
            role="status"
          >
            <i />
            {preview
              ? "Sample history"
              : connection === "live"
                ? "Live"
                : connection === "connecting"
                  ? "Connecting"
                  : "Offline"}
          </span>
          <div className="scene-controls">
            <button
              onClick={openFiles}
              title="Open selected checkout files"
              aria-label="Open files"
            >
              <Icon name="folder" />
            </button>
            <button
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
              aria-label={paused ? "Resume motion" : "Pause motion"}
              title={paused ? "Resume motion" : "Pause motion"}
            >
              <span aria-hidden="true">{paused ? ">" : "II"}</span>
            </button>
            <button
              aria-pressed={feedOpen}
              onClick={() => setFeedOpen(!feedOpen)}
              aria-label="Activity feed"
              title="Activity feed"
            >
              <Icon name="conversation" />
            </button>
            <button
              onClick={onSettings}
              aria-label="Visualization settings"
              title="Change visualization"
            >
              <Icon name="settings" />
            </button>
          </div>
        </div>
        {targets.length ? (
          <Suspense
            fallback={
              <div className="factory-scene-loading">Loading scene...</div>
            }
          >
            <FactoryScene
              visualization={visualization}
              targets={targets}
              calls={calls}
              selected={target?.id}
              choose={choose}
              paused={paused}
            />
          </Suspense>
        ) : (
          <div className="factory-scene-loading">
            {loading ? "Finding worktrees..." : "No checkouts available."}
          </div>
        )}
        {feedOpen && (
          <SceneFeed
            targets={targets}
            calls={calls}
            activity={activity}
            choose={choose}
            loading={loading}
          />
        )}
        {error && (
          <p className="scene-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
