import { FormEvent, useEffect, useState } from "react";
import type { AuthenticatedUser, WorkItem } from "@business-c/contracts";
import { createWorkItem, currentUser, listWorkItems, login, logout, updateWorkItem } from "./api";
import "./styles.css";

export function App() {
  const [records, setRecords] = useState<WorkItem[]>([]);
  const [title, setTitle] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [user, setUser] = useState<AuthenticatedUser | undefined>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  const load = async () => {
    setState("loading");
    try { setRecords(await listWorkItems()); setState("ready"); } catch { setState("error"); }
  };

  useEffect(() => { void currentUser().then((current) => { setUser(current); return load(); }).catch(() => setState("ready")); }, []);

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setState("loading");
    try { await login(email, password); setUser(await currentUser()); setPassword(""); await load(); } catch { setState("error"); }
  };

  const signOut = async () => {
    try { await logout(); setUser(undefined); setRecords([]); setState("ready"); } catch { setState("error"); }
  };

  if (!user) return <main><h1>Work items</h1><form onSubmit={signIn}><label htmlFor="email">Email<input id="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label htmlFor="password">Password<input id="password" type="password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><button type="submit">Sign in</button></form>{state === "loading" && <p role="status">Signing in…</p>}{state === "error" && <p role="alert">Could not sign in. Check the provisioned account and try again.</p>}</main>;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try { const record = await createWorkItem(title); setRecords((current) => [record, ...current]); setTitle(""); } catch { setState("error"); }
  };

  const toggle = async (record: WorkItem) => {
    try { const updated = await updateWorkItem(record.id, !record.completed); setRecords((current) => current.map((item) => item.id === updated.id ? updated : item)); } catch { setState("error"); }
  };

  return <main>
    <h1>Work items</h1><p>Signed in as {user.email}. <button onClick={() => void signOut()}>Sign out</button></p>
    <form onSubmit={submit}><label htmlFor="title">New record</label><input id="title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={120} required /><button type="submit">Create</button></form>
    {state === "loading" && <p role="status">Loading work items…</p>}
    {state === "error" && <p role="alert">Could not load or save work items. <button onClick={() => void load()}>Try again</button></p>}
    {state === "ready" && records.length === 0 && <p>No work items yet. Create the first one above.</p>}
    {state === "ready" && records.length > 0 && <ul>{records.map((record) => <li key={record.id}><label><input type="checkbox" checked={record.completed} onChange={() => void toggle(record)} /> {record.title}</label></li>)}</ul>}
  </main>;
}
