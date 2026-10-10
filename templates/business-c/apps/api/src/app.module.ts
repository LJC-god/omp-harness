import { Module } from "@nestjs/common";
import { DatabaseService } from "./database";
import { WorkItemsController, WorkItemsService } from "./records";
import { AuthController, AuthService, OriginGuard, SessionGuard } from "./auth";

@Module({
  controllers: [AuthController, WorkItemsController],
  providers: [DatabaseService, AuthService, OriginGuard, SessionGuard, WorkItemsService],
})
export class AppModule {}
