async function expectAuth(response: Response, action: string): Promise<boolean> {
  if (response.status === 401) return false;
  if (!response.ok) throw new Error(`Could not ${action} (HTTP ${response.status})`);
  return true;
}

/** Also renews the session, so opening the app keeps a 90-day login alive. */
export async function checkSession(): Promise<boolean> {
  return expectAuth(await fetch("/api/auth/session", { cache: "no-store" }), "check your session");
}

export async function logIn(password: string): Promise<boolean> {
  const response = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  return expectAuth(response, "log in");
}

export async function logOut(): Promise<void> {
  const response = await fetch("/api/auth/logout", { method: "POST" });
  if (!response.ok) throw new Error(`Could not log out (HTTP ${response.status})`);
}
