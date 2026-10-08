import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { checkSession, logIn, logOut } from "../sessionApi.ts";
import "./login.css";

type Gate =
  | { status: "checking" }
  | { status: "error"; message: string }
  | { status: "signed-out" }
  | { status: "signed-in" };

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

export function SessionGate({ children }: { children: (onLogOut: () => void) => ReactNode }) {
  const [gate, setGate] = useState<Gate>({ status: "checking" });
  const [attempt, setAttempt] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must restart a failed check.
  useEffect(() => {
    let active = true;
    checkSession().then(
      (signedIn) => {
        if (active) setGate({ status: signedIn ? "signed-in" : "signed-out" });
      },
      (cause: unknown) => {
        if (active) setGate({ status: "error", message: messageOf(cause) });
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);

  // An installed app resumes its page instead of reloading it: re-check (and so renew) the session
  // on every return, so an expired one lands on the login form rather than on request errors.
  const signedIn = gate.status === "signed-in";
  useEffect(() => {
    if (!signedIn) return;
    const recheck = () => {
      if (document.visibilityState !== "visible") return;
      checkSession().then(
        (stillSignedIn) => {
          if (!stillSignedIn) setGate({ status: "signed-out" });
        },
        // Offline on resume: keep the page, since unmounting it would drop an unsaved trade.
        (cause: unknown) => console.error(cause),
      );
    };
    document.addEventListener("visibilitychange", recheck);
    return () => document.removeEventListener("visibilitychange", recheck);
  }, [signedIn]);

  if (gate.status === "signed-in") {
    return children(() =>
      logOut().then(
        () => setGate({ status: "signed-out" }),
        (cause: unknown) => setGate({ status: "error", message: messageOf(cause) }),
      ),
    );
  }
  if (gate.status === "signed-out") {
    return <LoginForm onSignedIn={() => setGate({ status: "signed-in" })} />;
  }
  return (
    <main className="login">
      {gate.status === "checking" ? (
        <p role="status">Checking session…</p>
      ) : (
        <>
          <p role="alert">{gate.message}</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Retry
          </button>
        </>
      )}
    </main>
  );
}

export function LoginForm({ onSignedIn }: { onSignedIn: () => void }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (await logIn(password)) {
        onSignedIn();
        return;
      }
      setError("Wrong password");
    } catch (cause) {
      setError(messageOf(cause));
    }
    setSubmitting(false);
  }

  return (
    <main className="login">
      <form className="login-form" onSubmit={submit}>
        <h1>Trading Journal</h1>
        <label>
          Password
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button type="submit" disabled={submitting}>
          Log in
        </button>
      </form>
    </main>
  );
}
