import { describe, expect, it, vi } from "vitest";
import { vercelClient } from "./vercel.ts";

type Call = { method: string; url: URL; body: unknown };

function client(respond: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (input: URL | string | Request, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return new Response(JSON.stringify(respond(call)), { status });
  });
  return {
    calls,
    fetchImpl,
    api: vercelClient(
      { token: "tok", project: "proj", team: "team" },
      fetchImpl as unknown as typeof fetch,
      async () => {},
    ),
  };
}

describe("setProductionEnv", () => {
  it("upserts a sensitive Production-only variable", async () => {
    const { calls, api } = client((call) => (call.method === "GET" ? { envs: [] } : {}));
    await api.setProductionEnv("DATABASE_URL", "postgresql://secret");
    const post = calls.find((call) => call.method === "POST");
    expect(post?.url.pathname).toBe("/v10/projects/proj/env");
    expect(post?.url.searchParams.get("upsert")).toBe("true");
    expect(post?.url.searchParams.get("slug")).toBe("team");
    expect(post?.body).toEqual({
      key: "DATABASE_URL",
      value: "postgresql://secret",
      type: "sensitive",
      target: ["production"],
    });
  });

  it("refuses a variable that also targets preview or development", async () => {
    const { calls, api } = client(() => ({
      envs: [{ key: "DATABASE_URL", target: ["production", "preview"] }],
    }));
    await expect(api.setProductionEnv("DATABASE_URL", "v")).rejects.toThrow("non-production");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("never puts the value in an error", async () => {
    const { api } = client(() => ({}), 403);
    await expect(api.setProductionEnv("DATABASE_URL", "very-secret")).rejects.toThrow(
      /^Vercel GET \/v10\/projects\/proj\/env failed with 403$/,
    );
  });
});

it("detects an existing Production variable", async () => {
  const { api } = client(() => ({
    envs: [
      { key: "CRON_SECRET", target: ["production"] },
      { key: "OTHER", target: ["preview"] },
    ],
  }));
  expect(await api.hasProductionEnv("CRON_SECRET")).toBe(true);
  expect(await api.hasProductionEnv("OTHER")).toBe(false);
  expect(await api.hasProductionEnv("MISSING")).toBe(false);
});

describe("deployments", () => {
  it("finds the READY production deployment of a commit, polling until it appears", async () => {
    let polls = 0;
    const { calls, api } = client(() => ({ deployments: ++polls < 3 ? [] : [{ uid: "dpl_1" }] }));
    expect(await api.readyProductionDeployment("abc123")).toBe("dpl_1");
    expect(polls).toBe(3);
    const params = calls[0]?.url.searchParams;
    expect(Object.fromEntries(params ?? [])).toMatchObject({
      projectId: "proj",
      target: "production",
      state: "READY",
      sha: "abc123",
    });
  });

  it("gives up with a clear error", async () => {
    const { api } = client(() => ({ deployments: [] }));
    await expect(api.readyProductionDeployment("abc123")).rejects.toThrow(
      "Timed out waiting for a READY production deployment of abc123",
    );
  });

  it("redeploys to production and waits for READY", async () => {
    const states = ["BUILDING", "READY"];
    const { calls, api } = client((call) =>
      call.method === "POST"
        ? { id: "dpl_2", url: "x.vercel.app", readyState: "QUEUED" }
        : { id: "dpl_2", url: "x.vercel.app", readyState: states.shift(), alias: ["prod.app"] },
    );
    const deployment = await api.redeploy("dpl_1");
    expect(deployment.alias).toEqual(["prod.app"]);
    const post = calls[0];
    expect(post?.url.pathname).toBe("/v13/deployments");
    expect(post?.url.searchParams.get("forceNew")).toBe("1");
    expect(post?.body).toEqual({ name: "proj", deploymentId: "dpl_1", target: "production" });
  });

  it.each(["ERROR", "CANCELED"])("fails when the redeployment ends %s", async (state) => {
    const { api } = client((call) =>
      call.method === "POST"
        ? { id: "dpl_2", url: "x", readyState: "QUEUED" }
        : { id: "dpl_2", url: "x", readyState: state },
    );
    await expect(api.redeploy("dpl_1")).rejects.toThrow(state);
  });
});
