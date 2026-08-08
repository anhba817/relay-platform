import { Module } from "@nestjs/common";

import { SignupController } from "./signup.controller";

// Signup's home (chapter 3.1). Deliberately thin, and deliberately NOT
// importing MessagesModule: nothing here is tenant-scoped, so it needs none of
// the request-scoped machinery 2.2 built. The provisioning it calls lives in
// the repository's admin surface, which is a module-free function for exactly
// this reason — it runs before any tenant exists to scope to.
@Module({
  controllers: [SignupController],
})
export class TenancyModule {}
