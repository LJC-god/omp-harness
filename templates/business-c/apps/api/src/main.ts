import "reflect-metadata";
import { config } from "dotenv";
import { resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

config({ path: resolve(__dirname, "../.env") });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: { origin: process.env.PUBLIC_ORIGIN ?? "http://localhost:5173", credentials: true } });
  await app.listen(Number(process.env.PORT ?? 3000), "127.0.0.1");
}

void bootstrap();
