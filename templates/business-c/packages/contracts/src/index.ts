import { z } from "zod";

export const workItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  createdAt: z.string().datetime(),
});

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1, "Title is required").max(120),
});

export const updateWorkItemSchema = z.object({
  completed: z.boolean(),
});

export const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(12).max(1024),
});

export const authenticatedUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  role: z.enum(["admin", "user"]),
});

export const workItemsListResponseSchema = z.object({
  workItems: z.array(workItemSchema),
});

export type WorkItem = z.infer<typeof workItemSchema>;
export type CreateWorkItem = z.infer<typeof createWorkItemSchema>;
export type UpdateWorkItem = z.infer<typeof updateWorkItemSchema>;
export type AuthenticatedUser = z.infer<typeof authenticatedUserSchema>;
