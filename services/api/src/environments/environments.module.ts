import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module";
import { EnvironmentsController } from "./environments.controller";

/** The first controller this platform has had for environments at all.
 *
 * Seventeen chapters set environment-level things through other surfaces or through a
 * seeder; `retention_days` is the first one a customer sets for themselves, which is
 * why the module arrives with chapter 4.20 rather than with chapter 2.1.
 *
 * `AuthModule` IS THE ONLY IMPORT, on `AuditModule`'s template — the controller holds
 * no injected port because its one write is a standalone repository function rather
 * than a reader with a shape worth abstracting. */
@Module({
  imports: [AuthModule],
  controllers: [EnvironmentsController],
})
export class EnvironmentsModule {}
