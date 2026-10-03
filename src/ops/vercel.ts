export type VercelConfig = { token: string; project: string; team: string };

type Env = { key: string; target: string[] };
export type Deployment = { id: string; url: string; readyState: string; alias?: string[] };

const API = "https://api.vercel.com";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function vercelClient(
  { token, project, team }: VercelConfig,
  fetchImpl: typeof fetch = fetch,
  wait: (ms: number) => Promise<void> = sleep,
) {
  async function call<T>(
    method: "GET" | "POST",
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
  ): Promise<T> {
    const url = new URL(path, API);
    for (const [key, value] of Object.entries({ ...query, slug: team })) {
      url.searchParams.set(key, value);
    }
    const res = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Status and path only: a request body carries secret values, so it is never echoed.
    if (!res.ok) throw new Error(`Vercel ${method} ${path} failed with ${res.status}`);
    return (await res.json()) as T;
  }

  async function envs(): Promise<Env[]> {
    return (await call<{ envs: Env[] }>("GET", `/v10/projects/${project}/env`)).envs;
  }

  // Production-only by contract: a variable that also targets preview or development would give
  // previews a database, so refuse to touch it rather than silently narrow it.
  async function setProductionEnv(key: string, value: string) {
    if (
      (await envs()).some(
        (env) => env.key === key && env.target.some((target) => target !== "production"),
      )
    ) {
      throw new Error(`${key} exists with a non-production target; remove that target first`);
    }
    await call(
      "POST",
      `/v10/projects/${project}/env`,
      { upsert: "true" },
      {
        key,
        value,
        type: "sensitive",
        target: ["production"],
      },
    );
  }

  async function hasProductionEnv(key: string) {
    return (await envs()).some((env) => env.key === key && env.target.includes("production"));
  }

  async function waitFor<T>(find: () => Promise<T | undefined>, what: string, attempts = 60) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const found = await find();
      if (found !== undefined) return found;
      await wait(10_000);
    }
    throw new Error(`Timed out waiting for ${what}`);
  }

  // The Git integration builds each main push; redeploy that build so it picks up new env.
  async function readyProductionDeployment(sha: string) {
    return waitFor(
      async () =>
        (
          await call<{ deployments: { uid: string }[] }>("GET", "/v7/deployments", {
            projectId: project,
            target: "production",
            state: "READY",
            sha,
            limit: "1",
          })
        ).deployments[0]?.uid,
      `a READY production deployment of ${sha}`,
    );
  }

  async function redeploy(deploymentId: string): Promise<Deployment> {
    const created = await call<Deployment>(
      "POST",
      "/v13/deployments",
      { forceNew: "1" },
      { name: project, deploymentId, target: "production" },
    );
    return waitFor(async () => {
      const current = await call<Deployment>("GET", `/v13/deployments/${created.id}`);
      if (current.readyState === "ERROR" || current.readyState === "CANCELED") {
        throw new Error(`Redeployment ended in ${current.readyState}`);
      }
      return current.readyState === "READY" ? current : undefined;
    }, "the redeployment to become READY");
  }

  return { setProductionEnv, hasProductionEnv, readyProductionDeployment, redeploy };
}
