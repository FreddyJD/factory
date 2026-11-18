import { useEffect, useRef, useState } from "react";
import {
  createProductionRenderer,
  type ProductionState,
} from "../production-renderer";

export default function FactoryScene(props: ProductionState) {
  const host = useRef<HTMLDivElement>(null);
  const labels = useRef(new Map<string, HTMLButtonElement>());
  const renderer = useRef<ReturnType<typeof createProductionRenderer> | null>(
    null,
  );
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!host.current) return;
    try {
      renderer.current = createProductionRenderer(
        host.current,
        labels.current,
        () => setUnavailable(true),
      );
    } catch {
      setUnavailable(true);
    }
    return () => {
      renderer.current?.dispose();
      renderer.current = null;
    };
  }, []);
  useEffect(() => {
    renderer.current?.update(props);
  });
  return (
    <>
      <div
        ref={host}
        className="factory-canvas"
        aria-label={
          props.visualization === "kitchen"
            ? "Connected sushi kitchen"
            : "Connected factory line"
        }
      >
        {!unavailable &&
          props.targets.map((target) => (
            <button
              key={target.id}
              type="button"
              ref={(node) => {
                if (node) labels.current.set(target.id, node);
                else labels.current.delete(target.id);
              }}
              className="factory-building-label"
              aria-pressed={props.selected === target.id}
              onClick={() => props.choose(target.id)}
              title={target.branch}
            >
              {target.branch}
            </button>
          ))}
        {unavailable && (
          <div className="factory-webgl-fallback">
            3D rendering is unavailable. Use the checkout selector and activity
            feed.
          </div>
        )}
      </div>
      <button
        type="button"
        className="factory-reset"
        onClick={() => renderer.current?.reset()}
        title="Reset camera"
        aria-label="Reset factory camera"
      >
        Reset view
      </button>
    </>
  );
}
