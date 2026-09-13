"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const payload = await response.json().catch(() => null) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message || "Unable to sign in.");
      router.replace("/projects");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="auth-form" method="post" action="/api/auth/login" onSubmit={submit}>
      <label>
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required placeholder="you@studio.com" />
      </label>
      <label>
        <span>Password</span>
        <input name="password" type="password" autoComplete="current-password" required placeholder="••••••••" />
      </label>
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="primary-button" type="submit" disabled={busy}>
        {busy ? <span className="button-spinner" aria-hidden="true" /> : null}
        {busy ? "Signing in…" : "Open Studio"}
      </button>
    </form>
  );
}
