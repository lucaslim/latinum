import { type FullConfig, request } from "@playwright/test";

export const STORAGE_STATE = "e2e/.auth/state.json";

/** Every spec but `login.spec.ts` starts signed in with the local API's default password. */
export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("E2E login needs a baseURL");
  const context = await request.newContext({ baseURL });
  const response = await context.post("/api/auth/login", { data: { password: "journal" } });
  if (!response.ok()) throw new Error(`E2E login failed: HTTP ${response.status()}`);
  await context.storageState({ path: STORAGE_STATE });
  await context.dispose();
}
