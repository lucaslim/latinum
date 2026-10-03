import { Pool } from "@neondatabase/serverless";
import { appDatabaseUrl, generateSecret, passwordStatement } from "../src/ops/connection.ts";
import { proveDenial } from "../src/ops/denial.ts";
import { vercelClient } from "../src/ops/vercel.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// Registers the value with the runner's log masking before anything can print it.
function masked(value: string): string {
  console.log(`::add-mask::${value}`);
  return value;
}

async function main() {
  const ownerUrl = required("DATABASE_URL_OWNER");
  const vercel = vercelClient({
    token: required("VERCEL_TOKEN"),
    project: required("VERCEL_PROJECT"),
    team: required("VERCEL_TEAM_SLUG"),
  });
  const sha = required("GITHUB_SHA");

  const password = masked(generateSecret());
  const appUrl = masked(appDatabaseUrl(ownerUrl, password));

  const owner = new Pool({ connectionString: ownerUrl });
  try {
    await owner.query(passwordStatement(password));
    const { rows } = await owner.query(
      "SELECT pg_has_role('app_rw', 'neon_superuser', 'member') AS neon_superuser",
    );
    if (rows[0]?.neon_superuser !== false) throw new Error("app_rw must not be neon_superuser");
    console.log("app_rw password set; not a member of neon_superuser");
  } finally {
    await owner.end();
  }

  const app = new Pool({ connectionString: appUrl, max: 1 });
  try {
    const client = await app.connect();
    try {
      for (const line of await proveDenial(client)) console.log(line);
    } finally {
      client.release();
    }
  } finally {
    await app.end();
  }

  if (!(await vercel.hasProductionEnv("CRON_SECRET"))) {
    await vercel.setProductionEnv("CRON_SECRET", masked(generateSecret(32)));
    console.log("CRON_SECRET created for Production");
  }
  await vercel.setProductionEnv("DATABASE_URL", appUrl);
  console.log("DATABASE_URL set for Production only");

  const deployment = await vercel.redeploy(await vercel.readyProductionDeployment(sha));
  console.log(`Redeployed ${deployment.url}`);
  console.log(`Production aliases: ${(deployment.alias ?? []).join(", ") || "none reported"}`);
}

main().catch((error: unknown) => {
  // Message only: stacks and driver objects can carry connection details.
  console.error(`connect-production failed: ${error instanceof Error ? error.message : "unknown"}`);
  process.exitCode = 1;
});
