import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { getCurrentUser } from "@/lib/auth";

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/projects");

  return (
    <main className="auth-page">
      <div className="ambient ambient-one" />
      <div className="ambient ambient-two" />
      <section className="auth-card glass-panel" aria-labelledby="login-title">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <div>
            <strong>AH2D</strong>
            <span>Collaborative Studio</span>
          </div>
        </div>
        <div className="auth-copy">
          <p className="eyebrow">Secure workspace</p>
          <h1 id="login-title">Welcome back</h1>
          <p>Sign in to edit scenes, review changes and build together in real time.</p>
        </div>
        <LoginForm />
      </section>
    </main>
  );
}
