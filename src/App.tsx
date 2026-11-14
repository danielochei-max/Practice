import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { supabase } from "./supabase";

type Group = {
  id: string;
  name: string;
  join_code: string;
};

type Challenge = {
  id: string;
  title: string;
  ends_on: string;
};

type Member = {
  user_id: string;
  display_name: string;
};

type Completion = {
  user_id: string;
  completed_on: string;
};

type Dashboard = {
  group: Group;
  challenge: Challenge;
  members: Member[];
  completions: Completion[];
};

type Screen = "home" | "dashboard";

const GROUP_STORAGE_KEY = "buddyup-group-id";
const NAME_STORAGE_KEY = "buddyup-display-name";

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

async function ensureSignedIn() {
  if (!supabase) {
    throw new Error("The app hasn't been connected to its shared database yet.");
  }

  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  if (sessionData.session) return sessionData.session.user.id;

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error) throw error;
  if (!data.user) throw new Error("Could not start a guest session.");
  return data.user.id;
}

async function loadDashboard(groupId: string): Promise<Dashboard> {
  if (!supabase) throw new Error("Shared data is not configured.");

  const { data: group, error: groupError } = await supabase
    .from("groups")
    .select("id, name, join_code")
    .eq("id", groupId)
    .single();
  if (groupError?.code === "PGRST116") {
    throw new Error("This group isn't available here. Join again with an invite code.");
  }
  if (groupError) throw groupError;

  const { data: challenge, error: challengeError } = await supabase
    .from("challenges")
    .select("id, title, ends_on")
    .eq("group_id", groupId)
    .order("created_at", { ascending: false })
    .limit(1)
    .single();
  if (challengeError) throw challengeError;

  const { data: members, error: membersError } = await supabase
    .from("group_members")
    .select("user_id, display_name")
    .eq("group_id", groupId);
  if (membersError) throw membersError;

  const { data: completions, error: completionsError } = await supabase
    .from("completions")
    .select("user_id, completed_on")
    .eq("challenge_id", challenge.id);
  if (completionsError) throw completionsError;

  return {
    group: group as Group,
    challenge: challenge as Challenge,
    members: (members ?? []) as Member[],
    completions: (completions ?? []) as Completion[],
  };
}

export default function App() {
  const [screen, setScreen] = useState<Screen>(() =>
    localStorage.getItem(GROUP_STORAGE_KEY) ? "dashboard" : "home",
  );
  const [groupId, setGroupId] = useState(() => localStorage.getItem(GROUP_STORAGE_KEY) ?? "");
  const [displayName, setDisplayName] = useState(() => localStorage.getItem(NAME_STORAGE_KEY) ?? "");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [notice, setNotice] = useState("");
  const [joinCode, setJoinCode] = useState(() => new URLSearchParams(location.search).get("join") ?? "");

  useEffect(() => {
    if (!supabase) return;
    let active = true;

    void ensureSignedIn()
      .then((id) => {
        if (active) setUserId(id);
      })
      .catch((error: unknown) => {
        if (active) setErrorMessage(getErrorMessage(error));
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!supabase || !groupId) return;
    let active = true;

    const refresh = async () => {
      try {
        const data = await loadDashboard(groupId);
        if (active) {
          setDashboard(data);
          setErrorMessage("");
        }
      } catch (error) {
        if (active) {
          setErrorMessage(getErrorMessage(error));
          if (error instanceof Error && error.message.includes("isn't available here")) {
            localStorage.removeItem(GROUP_STORAGE_KEY);
            setGroupId("");
            setScreen("home");
          }
        }
      }
    };

    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [groupId]);

  const today = new Date().toISOString().slice(0, 10);
  const hasCompletedToday = dashboard?.completions.some(
    (completion) => completion.user_id === userId && completion.completed_on === today,
  ) ?? false;
  const challengeEnded = dashboard ? today > dashboard.challenge.ends_on : false;
  const inviteUrl = useMemo(() => {
    if (!dashboard) return "";
    const url = new URL(window.location.href);
    url.search = new URLSearchParams({ join: dashboard.group.join_code }).toString();
    return url.toString();
  }, [dashboard]);

  async function createChallenge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("name") ?? "").trim();
    const groupName = String(formData.get("groupName") ?? "").trim();
    const challengeTitle = String(formData.get("challengeTitle") ?? "").trim();
    const durationDays = Number(formData.get("durationDays"));
    if (!name || !groupName || !challengeTitle) {
      setErrorMessage("Please fill in each field.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    try {
      await ensureSignedIn();
      const { data, error } = await supabase.rpc("create_group", {
        p_name: groupName,
        p_challenge_title: challengeTitle,
        p_duration_days: durationDays,
        p_display_name: name,
      });
      if (error) throw error;
      if (typeof data !== "string") throw new Error("The group was created, but its ID was not returned.");
      saveGroup(data, name);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function joinChallenge(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!supabase) return;

    const formData = new FormData(event.currentTarget);
    const name = String(formData.get("joinName") ?? "").trim();
    const code = String(formData.get("joinCode") ?? "").trim().toUpperCase();
    if (!name || !code) {
      setErrorMessage("Enter your name and the invite code.");
      return;
    }

    setBusy(true);
    setErrorMessage("");
    try {
      await ensureSignedIn();
      const { data, error } = await supabase.rpc("join_group", {
        p_join_code: code,
        p_display_name: name,
      });
      if (error) throw error;
      if (typeof data !== "string") throw new Error("Could not join this group.");
      saveGroup(data, name);
      window.history.replaceState({}, "", window.location.pathname);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function saveGroup(id: string, name: string) {
    localStorage.setItem(GROUP_STORAGE_KEY, id);
    localStorage.setItem(NAME_STORAGE_KEY, name);
    setDisplayName(name);
    setGroupId(id);
    setDashboard(null);
    setScreen("dashboard");
  }

  async function toggleCheckIn() {
    if (!supabase || !dashboard || !userId) return;
    setBusy(true);
    setErrorMessage("");

    try {
      if (hasCompletedToday) {
        const { error } = await supabase
          .from("completions")
          .delete()
          .eq("challenge_id", dashboard.challenge.id)
          .eq("user_id", userId)
          .eq("completed_on", today);
        if (error) throw error;
        setNotice("Check-in removed.");
      } else {
        const { error } = await supabase.from("completions").insert({
          challenge_id: dashboard.challenge.id,
          user_id: userId,
          completed_on: today,
        });
        if (error) throw error;
        setNotice("Nice work! Your group can see your check-in.");
      }
      const freshDashboard = await loadDashboard(groupId);
      setDashboard(freshDashboard);
    } catch (error) {
      setErrorMessage(getErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setNotice("Invite link copied. Send it to your friends!");
    } catch {
      setNotice(`Share this invite code: ${dashboard?.group.join_code ?? ""}`);
    }
  }

  function leaveGroup() {
    localStorage.removeItem(GROUP_STORAGE_KEY);
    setGroupId("");
    setDashboard(null);
    setScreen("home");
    setNotice("");
    setErrorMessage("");
  }

  if (!supabase) {
    return (
      <main className="setup-page">
        <div className="setup-card">
          <div className="brand-mark">B</div>
          <p className="eyebrow">YOUR NEW GROUP TRADITION</p>
          <h1>BuddyUp</h1>
          <p className="setup-copy">The app is ready. Connect a Supabase project to turn on shared challenges and invite your friends.</p>
          <ol>
            <li>Create a Supabase project.</li>
            <li>Copy <code>.env.example</code> to <code>.env.local</code> and fill in the project URL and anon key.</li>
            <li>Run <code>supabase/schema.sql</code> in the Supabase SQL Editor and enable anonymous sign-ins.</li>
            <li>Restart the app with <code>npm run dev</code>.</li>
          </ol>
          <p className="setup-footnote">The setup steps are also in the README.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="/" onClick={(event) => { event.preventDefault(); leaveGroup(); }}>
          <span className="brand-mark">B</span>
          BuddyUp
        </a>
        {screen === "dashboard" && (
          <button className="text-button" type="button" onClick={leaveGroup}>Switch group</button>
        )}
      </header>

      {errorMessage && <div className="message error-message" role="alert">{errorMessage}</div>}
      {notice && <div className="message success-message" role="status">{notice}</div>}

      {screen === "dashboard" && dashboard ? (
        <section className="dashboard">
          <div className="dashboard-heading">
            <p className="eyebrow">YOUR CREW</p>
            <h1>{dashboard.group.name}</h1>
            <p className="muted">A little progress is better with friends.</p>
          </div>

          <div className="invite-strip">
            <div className="invite-details">
              <span className="small-label">INVITE FRIENDS</span>
              <strong>{dashboard.group.join_code}</strong>
              <p className="invite-hint">Share the link or let friends scan to join.</p>
              <button type="button" className="button button-dark invite-button" onClick={() => void copyInvite()}>
                Copy invite link
              </button>
            </div>
            <div className="invite-qr">
              <QRCodeSVG
                value={inviteUrl}
                size={132}
                level="M"
                title={`Scan to join ${dashboard.group.name}`}
              />
              <span>Scan to join</span>
            </div>
          </div>

          <div className="challenge-card">
            <div className="challenge-card-top">
              <span className="pill">{challengeEnded ? "CHALLENGE ENDED" : "TODAY'S CHALLENGE"}</span>
              <span className="small-label">UNTIL {new Date(`${dashboard.challenge.ends_on}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>
            </div>
            <h2>{dashboard.challenge.title}</h2>
            <p className="muted">Show up today. Your future self (and your crew) will thank you.</p>
            <button
              type="button"
              className={`button checkin-button${hasCompletedToday ? " completed" : ""}`}
              disabled={busy || challengeEnded}
              onClick={() => void toggleCheckIn()}
            >
              {hasCompletedToday ? "✓  Done for today — undo" : "I did it today"}
            </button>
          </div>

          <section className="leaderboard">
            <div className="section-heading">
              <div>
                <p className="eyebrow">SHOWING UP</p>
                <h2>Group leaderboard</h2>
              </div>
              <span className="member-count">{dashboard.members.length} {dashboard.members.length === 1 ? "person" : "people"}</span>
            </div>
            <ol className="member-list">
              {[...dashboard.members]
                .map((member) => ({
                  ...member,
                  score: dashboard.completions.filter((completion) => completion.user_id === member.user_id).length,
                }))
                .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
                .map((member, index) => (
                  <li className="member-row" key={member.user_id}>
                    <span className={`rank rank-${index + 1}`}>{index + 1}</span>
                    <span className="avatar">{member.display_name.charAt(0).toUpperCase()}</span>
                    <span className="member-name">{member.display_name}{member.user_id === userId ? <span className="you-label">YOU</span> : null}</span>
                    <strong className="score">{member.score}<span> {member.score === 1 ? "day" : "days"}</span></strong>
                  </li>
                ))}
            </ol>
            <p className="leaderboard-note">Scores refresh automatically as your friends check in.</p>
          </section>
        </section>
      ) : (
        <section className="home">
          <div className="hero">
            <div className="hero-sticker" aria-hidden="true">✦</div>
            <p className="eyebrow">SMALL GOALS, GOOD COMPANY</p>
            <h1>Make a little<br /><span>progress together.</span></h1>
            <p className="hero-copy">Pick something fun. Get your people. Cheer each other on, one day at a time.</p>
          </div>

          <div className="forms-grid">
            <form className="form-card create-card" onSubmit={(event) => void createChallenge(event)}>
              <div className="form-card-heading">
                <span className="step-number">01</span>
                <div><h2>Start a challenge</h2><p>Be the one who gets it going.</p></div>
              </div>
              <label>
                Your name
                <input name="name" autoComplete="name" placeholder="e.g. Alex" defaultValue={displayName} maxLength={32} required />
              </label>
              <label>
                Group name
                <input name="groupName" placeholder="e.g. The Sunday Crew" maxLength={48} required />
              </label>
              <label>
                What are you challenging each other to do?
                <input name="challengeTitle" placeholder="e.g. Take a 20-minute walk" maxLength={100} required />
              </label>
              <label>
                Challenge length
                <select name="durationDays" defaultValue="7">
                  <option value="7">7 days</option>
                  <option value="14">14 days</option>
                  <option value="30">30 days</option>
                </select>
              </label>
              <button className="button button-coral" type="submit" disabled={busy || !userId}>
                {busy ? "Starting..." : "Create my group"}
              </button>
            </form>

            <form className="form-card join-card" onSubmit={(event) => void joinChallenge(event)}>
              <div className="form-card-heading">
                <span className="step-number pale">02</span>
                <div><h2>Join your friends</h2><p>Got an invite code? You're in.</p></div>
              </div>
              <label>
                Your name
                <input name="joinName" autoComplete="name" placeholder="e.g. Alex" defaultValue={displayName} maxLength={32} required />
              </label>
              <label>
                Invite code
                <input
                  name="joinCode"
                  placeholder="16-character code"
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                  maxLength={16}
                  autoCapitalize="characters"
                  required
                />
              </label>
              <button className="button button-outline" type="submit" disabled={busy || !userId}>
                {busy ? "Joining..." : "Join the challenge"}
              </button>
              <p className="join-hint">No account or password needed. Just pick a name and join in.</p>
            </form>
          </div>
        </section>
      )}

      <footer className="footer">Good things are easier together.</footer>
    </main>
  );
}
