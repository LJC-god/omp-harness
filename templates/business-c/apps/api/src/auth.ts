import { Body, CanActivate, ConflictException, Controller, ExecutionContext, Get, HttpException, Inject, Injectable, Post, Req, Res, UnauthorizedException, UseGuards } from "@nestjs/common";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { Request, Response } from "express";
import { authenticatedUserSchema, loginSchema } from "@business-c/contracts";
import { DatabaseService } from "./database";

const scrypt = promisify(scryptCallback);
const sessionName = "business_c_session";
const sessionLifetimeMs = 1000 * 60 * 60 * 8;
const loginWindowMs = 1000 * 60 * 15;
const loginLimit = 5;
const attemptedLoginsByIp = new Map<string, number[]>();
const attemptedLoginsByEmail = new Map<string, number[]>();
const attemptKeyLimit = 1_000;
const dummySalt = "local-auth-dummy-salt";

export type AuthenticatedUser = { id: string; email: string; role: "admin" | "user" };
export type AuthenticatedRequest = Request & { user: AuthenticatedUser };

function tokenHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function cookieValue(request: Request, name: string) {
  return request.headers.cookie?.split(";").map((part: string) => part.trim().split("="))
    .find((pair: string[]) => pair[0] === name)?.[1];
}
function checkAndRecordAttempt(attemptsByKey: Map<string, number[]>, key: string, now: number) {
  // ponytail: bounded O(n) cleanup (1,000 keys); use a shared TTL store for multi-instance deployments.
  for (const [existingKey, times] of attemptsByKey) {
    const active = times.filter((time) => now - time < loginWindowMs);
    if (active.length) attemptsByKey.set(existingKey, active); else attemptsByKey.delete(existingKey);
  }
  const attempts = attemptsByKey.get(key) ?? [];
  if (attempts.length >= loginLimit) throw new HttpException("Too many login attempts", 429);
  if (!attempts.length && attemptsByKey.size >= attemptKeyLimit) throw new HttpException("Too many login attempts", 429);
  attempts.push(now);
  attemptsByKey.set(key, attempts);
}

@Injectable()
export class AuthService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async provision(email: string, password: string, role: "admin" | "user") {
    if (password.length < 12) throw new UnauthorizedException("Provisioning password must be at least 12 characters.");
    if (await this.database.user.findUnique({ where: { email } })) throw new ConflictException("User already exists; provisioning never resets an existing account.");
    const salt = randomBytes(16).toString("hex");
    const hash = (await scrypt(password, salt, 64)) as Buffer;
    return this.database.user.create({ data: { email, role, passwordSalt: salt, passwordHash: hash.toString("hex") } });
  }

  async login(email: string, password: string, ip: string) {
    const now = Date.now();
    checkAndRecordAttempt(attemptedLoginsByIp, ip, now);
    checkAndRecordAttempt(attemptedLoginsByEmail, email, now);
    const user = await this.database.user.findUnique({ where: { email } });
    const actual = Buffer.from(user?.passwordHash ?? "00".repeat(64), "hex");
    const expected = (await scrypt(password, user?.passwordSalt ?? dummySalt, 64)) as Buffer;
    if (!user || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new UnauthorizedException("Invalid email or password");
    const token = randomBytes(32).toString("hex");
    await this.database.session.create({ data: { tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + sessionLifetimeMs) } });
    return token;
  }

  async session(token: string | undefined): Promise<AuthenticatedUser | undefined> {
    if (!token) return undefined;
    const session = await this.database.session.findUnique({ where: { tokenHash: tokenHash(token) }, include: { user: true } });
    if (!session || session.expiresAt <= new Date()) return undefined;
    return { id: session.user.id, email: session.user.email, role: session.user.role };
  }

  async logout(token: string | undefined) {
    if (token) await this.database.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  }
}

@Injectable()
export class OriginGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
    const origin = request.headers.origin;
    if (!origin || origin !== (process.env.PUBLIC_ORIGIN ?? "http://localhost:5173")) throw new UnauthorizedException("Untrusted request origin");
    return true;
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = await this.auth.session(cookieValue(request, sessionName));
    if (!user) throw new UnauthorizedException("Authentication required");
    request.user = user;
    return true;
  }
}

@Controller("auth")
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post("login")
  @UseGuards(OriginGuard)
  async login(@Req() request: Request, @Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) throw new UnauthorizedException("Invalid email or password");
    const token = await this.auth.login(parsed.data.email, parsed.data.password, request.ip ?? request.socket.remoteAddress ?? "unknown");
    response.cookie(sessionName, token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
    return { ok: true };
  }

  @Post("logout")
  @UseGuards(OriginGuard, SessionGuard)
  async logout(@Req() request: AuthenticatedRequest, @Res({ passthrough: true }) response: Response) {
    await this.auth.logout(cookieValue(request, sessionName));
    response.clearCookie(sessionName, { httpOnly: true, sameSite: "lax", path: "/" });
    return { ok: true };
  }

  @Get("session")
  @UseGuards(SessionGuard)
  session(@Req() request: AuthenticatedRequest) {
    return authenticatedUserSchema.parse(request.user);
  }
}
