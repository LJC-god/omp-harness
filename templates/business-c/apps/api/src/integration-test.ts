import "reflect-metadata";
import assert from "node:assert/strict";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { DatabaseService } from "./database";
import { AuthService } from "./auth";

async function main() {
  const app = await NestFactory.create(AppModule, { logger: false });
  const database = app.get(DatabaseService);
  const auth = app.get(AuthService);
  await database.workItem.deleteMany();
  await database.session.deleteMany();
  await database.user.deleteMany();
  await auth.provision("owner@example.test", "owner-password-for-test", "user");
  await auth.provision("other@example.test", "other-password-for-test", "user");
  await assert.rejects(() => auth.provision("owner@example.test", "changed-password-for-test", "admin"));
  await app.listen(0, "127.0.0.1");
  const address = app.getHttpServer().address();
  assert(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/work-items`;
  const origin = process.env.PUBLIC_ORIGIN!;
  const login = async (email: string, password: string) => {
    const response = await fetch(baseUrl.replace("/work-items", "/auth/login"), { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email, password }) });
    assert.equal(response.status, 201);
    return response.headers.get("set-cookie")!;
  };

  try {
    const anonymous = await fetch(baseUrl);
    assert.equal(anonymous.status, 401);
    const ownerCookie = await login("owner@example.test", "owner-password-for-test");
    const rejected = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", origin, cookie: ownerCookie }, body: JSON.stringify({ title: "" }) });
    assert.equal(rejected.status, 400);

    const created = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", origin, cookie: ownerCookie }, body: JSON.stringify({ title: "Persisted record" }) });
    assert.equal(created.status, 201);
    const record = await created.json() as { id: string; completed: boolean; title: string };
    assert.equal(record.title, "Persisted record");
    assert.equal(record.completed, false);

    const otherCookie = await login("other@example.test", "other-password-for-test");
    const denied = await fetch(`${baseUrl}/${record.id}`, { method: "PATCH", headers: { "content-type": "application/json", origin, cookie: otherCookie }, body: JSON.stringify({ completed: true }) });
    assert.equal(denied.status, 404);
    const toggled = await fetch(`${baseUrl}/${record.id}`, { method: "PATCH", headers: { "content-type": "application/json", origin, cookie: ownerCookie }, body: JSON.stringify({ completed: true }) });
    assert.equal(toggled.status, 200);
    assert.equal((await toggled.json() as { completed: boolean }).completed, true);

    const listed = await fetch(baseUrl, { headers: { cookie: ownerCookie } });
    assert.equal(listed.status, 200);
    const listedItems = (await listed.json() as { workItems: Array<{ id: string; completed: boolean }> }).workItems;
    assert.equal(listedItems.length, 1);
    assert.equal(listedItems[0]?.id, record.id);
    assert.equal(listedItems[0]?.completed, true);
    const logout = await fetch(baseUrl.replace("/work-items", "/auth/logout"), { method: "POST", headers: { origin, cookie: ownerCookie } });
    assert.equal(logout.status, 201);
    const invalidated = await fetch(baseUrl, { headers: { cookie: ownerCookie } });
    assert.equal(invalidated.status, 401);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const rejectedLogin = await fetch(baseUrl.replace("/work-items", "/auth/login"), { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: "unknown@example.test", password: "wrong-password-for-test" }) });
      assert.equal(rejectedLogin.status, 401);
    }
    const limitedLogin = await fetch(baseUrl.replace("/work-items", "/auth/login"), { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: "different@example.test", password: "wrong-password-for-test" }) });
    assert.equal(limitedLogin.status, 429);
    console.log("PostgreSQL integration test passed");
  } finally {
    await app.close();
  }
}

void main();
