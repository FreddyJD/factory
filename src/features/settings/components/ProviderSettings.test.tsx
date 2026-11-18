// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProviderSettings } from "./ProviderSettings";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../../../shared/api", () => ({ api }));
beforeEach(() => {
  api.mockReset();
});
afterEach(cleanup);

it("saves an explicit reasoning output parameter and a separate output reserve", async () => {
  api.mockResolvedValue([]);
  render(<ProviderSettings onRefresh={() => {}} />);
  fireEvent.change(screen.getByLabelText("Model ID"), {
    target: { value: "reasoning-model" },
  });
  fireEvent.change(screen.getByLabelText("Context tokens"), {
    target: { value: "128000" },
  });
  fireEvent.change(screen.getByLabelText("Output token reserve"), {
    target: { value: "2048" },
  });
  fireEvent.change(screen.getByLabelText("Output limit parameter"), {
    target: { value: "max_completion_tokens" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save endpoint" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "provider_save",
      expect.objectContaining({
        modelId: "reasoning-model",
        context: 128000,
        output: 2048,
        outputParameter: "max_completion_tokens",
      }),
    ),
  );
  await screen.findByText(
    "Connection saved. Select this model when creating an issue.",
  );
  expect(
    (screen.getByLabelText("Output token reserve") as HTMLInputElement).value,
  ).toBe("4096");
  expect(
    (screen.getByLabelText("Output limit parameter") as HTMLSelectElement)
      .value,
  ).toBe("provider_default");
});

it("loads the saved output settings when editing without changing the destination", async () => {
  api.mockResolvedValue([
    {
      id: "local",
      name: "Local",
      baseUrl: "http://localhost:11434/v1",
      modelId: "test",
      context: 64000,
      output: 1024,
      outputParameter: "max_tokens",
      hasKey: false,
    },
  ]);
  render(<ProviderSettings onRefresh={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(
    (screen.getByLabelText("Output token reserve") as HTMLInputElement).value,
  ).toBe("1024");
  expect(
    (screen.getByLabelText("Output limit parameter") as HTMLSelectElement)
      .value,
  ).toBe("max_tokens");
  expect(
    (screen.getByLabelText("API base URL") as HTMLInputElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save endpoint" }));
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      "provider_save",
      expect.objectContaining({
        id: "local",
        baseUrl: "http://localhost:11434/v1",
        modelId: "test",
        output: 1024,
        outputParameter: "max_tokens",
      }),
    ),
  );
});
