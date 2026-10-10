import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { AuthService } from "../src/auth";
import { DatabaseService } from "../src/database";

config({ path: resolve(__dirname, "../.env") });

const email = process.env.AUTH_USER_EMAIL;
const password = process.env.AUTH_USER_PASSWORD;
const role = process.env.AUTH_USER_ROLE;
if (!email || !password || (role !== "admin" && role !== "user")) throw new Error("Set AUTH_USER_EMAIL, AUTH_USER_PASSWORD (12+ characters), and AUTH_USER_ROLE (admin or user).");

async function provision() {
  const database = new DatabaseService();
  try {
    await database.$connect();
    await new AuthService(database).provision(email, password, role);
    console.log(`Provisioned ${role} ${email}`);
  } finally {
    await database.$disconnect();
  }
}

void provision();
