import { authenticatedUserSchema, loginSchema, workItemSchema, createWorkItemSchema, workItemsListResponseSchema, updateWorkItemSchema, type AuthenticatedUser, type WorkItem } from "@business-c/contracts";

const baseUrl = `${import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000"}/work-items`;

async function request(path = "", init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, credentials: "include", headers: { "content-type": "application/json", ...init?.headers } });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
  return response.json() as Promise<unknown>;
}

export async function listWorkItems(): Promise<WorkItem[]> {
  return workItemsListResponseSchema.parse(await request()).workItems;
}

export async function createWorkItem(title: string): Promise<WorkItem> {
  return workItemSchema.parse(await request("", { method: "POST", body: JSON.stringify(createWorkItemSchema.parse({ title })) }));
}

export async function updateWorkItem(id: string, completed: boolean): Promise<WorkItem> {
  return workItemSchema.parse(await request(`/${id}`, { method: "PATCH", body: JSON.stringify(updateWorkItemSchema.parse({ completed })) }));
}

export async function login(email: string, password: string): Promise<void> {
  await request("/../auth/login", { method: "POST", body: JSON.stringify(loginSchema.parse({ email, password })) });
}

export async function logout(): Promise<void> {
  await request("/../auth/logout", { method: "POST" });
}

export async function currentUser(): Promise<AuthenticatedUser> {
  return authenticatedUserSchema.parse(await request("/../auth/session"));
}
