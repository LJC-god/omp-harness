import { BadRequestException, Body, Controller, Get, Inject, Injectable, NotFoundException, Param, Patch, Post, Req, UseGuards } from "@nestjs/common";
import { createWorkItemSchema, updateWorkItemSchema } from "@business-c/contracts";
import { OriginGuard, SessionGuard, type AuthenticatedRequest } from "./auth";
import { DatabaseService } from "./database";

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { flatten(): unknown } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException({ message: "Invalid request", issues: parsed.error.flatten() });
  return parsed.data;
}

function toResponse(record: { id: string; title: string; completed: boolean; createdAt: Date }) {
  return { id: record.id, title: record.title, completed: record.completed, createdAt: record.createdAt.toISOString() };
}

@Injectable()
export class WorkItemsService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(ownerId: string) {
    return (await this.database.workItem.findMany({ where: { ownerId }, orderBy: { createdAt: "desc" } })).map(toResponse);
  }

  async create(ownerId: string, body: unknown) {
    const input = parseBody(createWorkItemSchema, body);
    return toResponse(await this.database.workItem.create({ data: { ...input, ownerId } }));
  }

  async update(ownerId: string, id: string, body: unknown) {
    const input = parseBody(updateWorkItemSchema, body);
    try {
      const record = await this.database.workItem.findFirst({ where: { id, ownerId } });
      if (!record) throw new NotFoundException("Work item not found");
      return toResponse(await this.database.workItem.update({ where: { id }, data: input }));
    } catch (error: unknown) {
      if (typeof error === "object" && error && "code" in error && error.code === "P2025") throw new NotFoundException("Record not found");
      throw error;
    }
  }
}

@Controller("work-items")
@UseGuards(OriginGuard, SessionGuard)
export class WorkItemsController {
  constructor(@Inject(WorkItemsService) private readonly workItems: WorkItemsService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest) {
    return { workItems: await this.workItems.list(request.user.id) };
  }

  @Post()
  create(@Req() request: AuthenticatedRequest, @Body() body: unknown) {
    return this.workItems.create(request.user.id, body);
  }

  @Patch(":id")
  update(@Req() request: AuthenticatedRequest, @Param("id") id: string, @Body() body: unknown) {
    return this.workItems.update(request.user.id, id, body);
  }
}
