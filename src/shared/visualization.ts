export type Visualization = "factory" | "kitchen";

export function savedVisualization(): Visualization {
  try {
    return localStorage.getItem("factory-visualization") === "kitchen"
      ? "kitchen"
      : "factory";
  } catch {
    return "factory";
  }
}
