// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { GitHubRepositorySettings } from "./GitHubRepositorySettings";
import { api } from "../../../shared/api";

vi.mock("../../../shared/api", () => ({ api: vi.fn() }));
const accounts = [
  { id: "1", login: "personal" },
  { id: "2", login: "enterprise" },
];
const project = {
  id: "repo",
  name: "factory",
  path: "/repo",
  githubAccountId: "2",
};
const refresh = vi.fn();
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") return accounts;
    throw Error(`Unexpected operation ${action}`);
  });
});
afterEach(cleanup);

it("lists multiple repository accounts and persists a per-project selection once", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") return accounts;
    if (action === "project_github_account")
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw Error(`Unexpected operation ${action}`);
  });
  render(<GitHubRepositorySettings project={project} onRefresh={refresh} />);
  const region = screen.getByRole("region", {
    name: "GitHub repository accounts",
  });
  await within(region).findByText("personal");
  expect(within(region).getByText("enterprise")).toBeTruthy();
  const select = screen.getByLabelText(
    "Repository account for factory",
  ) as HTMLSelectElement;
  expect(select.value).toBe("2");
  fireEvent.change(select, { target: { value: "1" } });
  const save = screen.getByRole("button", { name: "Save repository account" });
  fireEvent.click(save);
  fireEvent.submit(save.closest("form")!);
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(([action]) => action === "project_github_account"),
  ).toHaveLength(1);
  expect(api).toHaveBeenCalledWith("project_github_account", {
    projectId: "repo",
    accountId: "1",
  });
  await act(async () => finish({ ...project, githubAccountId: "1" }));
  expect(refresh).toHaveBeenCalledOnce();
  expect(
    (
      screen.getByRole("button", {
        name: "Save repository account",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    vi
      .mocked(api)
      .mock.calls.some(
        ([action]) =>
          action.startsWith("login_") || action === "configure_github",
      ),
  ).toBe(false);
});

it("connects a repository account separately from Copilot and immediately clears the token field", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") return accounts;
    if (action === "github_account_save")
      return new Promise((resolve) => {
        finish = resolve;
      });
    throw Error(`Unexpected operation ${action}`);
  });
  render(<GitHubRepositorySettings onRefresh={refresh} />);
  await screen.findByText("personal");
  expect(screen.queryByLabelText(/Repository account for/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add GitHub account" }));
  const token = screen.getByLabelText(
    "GitHub personal access token",
  ) as HTMLInputElement;
  expect(token.type).toBe("password");
  fireEvent.change(token, { target: { value: "github_pat_fixture" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Connect repository account" }),
  );
  expect(token.value).toBe("");
  expect(api).toHaveBeenCalledWith("github_account_save", {
    token: "github_pat_fixture",
  });
  await act(async () => finish(accounts));
  await screen.findByText(/GitHub account connected/);
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Add GitHub account" }),
  );
  expect(screen.queryByLabelText("GitHub personal access token")).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(
    vi.mocked(api).mock.calls.some(([action]) => action.startsWith("login_")),
  ).toBe(false);
});

it("keeps failed selections editable and can reset to CLI default", async () => {
  vi.mocked(api).mockImplementation(async (action, args) => {
    if (action === "github_accounts") return accounts;
    if (action === "project_github_account") {
      if (args?.accountId === "1") throw Error("Could not save account");
      return { ...project, githubAccountId: null };
    }
    throw Error(`Unexpected operation ${action}`);
  });
  render(<GitHubRepositorySettings project={project} onRefresh={refresh} />);
  await screen.findByText("personal");
  const select = screen.getByLabelText("Repository account for factory");
  fireEvent.change(select, { target: { value: "1" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save repository account" }),
  );
  await screen.findByRole("alert");
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.change(select, { target: { value: "" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save repository account" }),
  );
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith("project_github_account", {
      projectId: "repo",
      accountId: null,
    }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
});

it("does not silently replace an unavailable account and resets selection between projects", async () => {
  const { rerender } = render(
    <GitHubRepositorySettings
      project={{ ...project, githubAccountId: "missing" }}
      onRefresh={refresh}
    />,
  );
  await screen.findByText("personal");
  expect(
    (
      screen.getByLabelText(
        "Repository account for factory",
      ) as HTMLSelectElement
    ).value,
  ).toBe("missing");
  expect(
    screen.getByRole("option", { name: "Saved account unavailable" }),
  ).toBeTruthy();
  rerender(
    <GitHubRepositorySettings
      project={{ ...project, id: "other", name: "work" }}
      onRefresh={refresh}
    />,
  );
  expect(
    (screen.getByLabelText("Repository account for work") as HTMLSelectElement)
      .value,
  ).toBe("2");
});

it("keeps a removed unsaved selection visible as unavailable and blocks saving it", async () => {
  let current = accounts;
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") return current;
    if (action === "github_account_remove") {
      current = accounts.slice(1);
      return current;
    }
    throw Error(`Unexpected operation ${action}`);
  });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<GitHubRepositorySettings project={project} onRefresh={refresh} />);
  await screen.findByText("personal");
  fireEvent.change(screen.getByLabelText("Repository account for factory"), {
    target: { value: "1" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Remove GitHub account personal" }),
  );
  await screen.findByRole("option", { name: "Saved account unavailable" });
  expect(
    (
      screen.getByLabelText(
        "Repository account for factory",
      ) as HTMLSelectElement
    ).value,
  ).toBe("1");
  expect(
    (
      screen.getByRole("button", {
        name: "Save repository account",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([action]) => action === "project_github_account"),
  ).toBe(false);
  confirm.mockRestore();
});

it("preserves a newer unsaved edit when delayed saved-project props arrive", async () => {
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") return accounts;
    if (action === "project_github_account")
      return { ...project, githubAccountId: "1" };
    throw Error(`Unexpected operation ${action}`);
  });
  const { rerender } = render(
    <GitHubRepositorySettings project={project} onRefresh={refresh} />,
  );
  await screen.findByText("personal");
  const select = screen.getByLabelText(
    "Repository account for factory",
  ) as HTMLSelectElement;
  fireEvent.change(select, { target: { value: "1" } });
  fireEvent.click(
    screen.getByRole("button", { name: "Save repository account" }),
  );
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  fireEvent.change(select, { target: { value: "" } });
  rerender(
    <GitHubRepositorySettings
      project={{ ...project, githubAccountId: "1" }}
      onRefresh={refresh}
    />,
  );
  expect(select.value).toBe("");
  expect(
    (
      screen.getByRole("button", {
        name: "Save repository account",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("recovers discovery errors on refresh and requires confirmation before account removal", async () => {
  let failed = true;
  vi.mocked(api).mockImplementation(async (action) => {
    if (action === "github_accounts") {
      if (failed) throw Error("Cannot read saved accounts");
      return accounts;
    }
    throw Error(`Unexpected operation ${action}`);
  });
  render(<GitHubRepositorySettings onRefresh={refresh} />);
  await screen.findByRole("alert");
  failed = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
  await screen.findByText("personal");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  fireEvent.click(
    screen.getByRole("button", { name: "Remove GitHub account personal" }),
  );
  expect(confirm).toHaveBeenCalledOnce();
  expect(
    vi
      .mocked(api)
      .mock.calls.some(([action]) => action === "github_account_remove"),
  ).toBe(false);
  confirm.mockRestore();
});
