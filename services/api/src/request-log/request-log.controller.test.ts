import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import type { RequestWithTenant } from "../messages/request-with-tenant";
import { RequestLogController } from "./request-log.controller";
import type { RequestLogPage } from "./reader";
import type { EndpointSet, RequestLogReaderPort } from "./request-log.port";

// FR-011's refusal, WHICH NO HTTP PATH CAN REACH TODAY — and that is why it is here.
//
// The route declares `@Accepts("application")`, so `CredentialGuard` refuses every other
// class at the door with `wrong_credential_type`; and an application credential is minted
// against an environment, so it always carries one. The branch report is what said the arm
// had never run, against a suite that drives the route over real HTTP.
//
// KEPT RATHER THAN DELETED, and the difference from chapter 4.6's dead branches is that a
// requirement asks for this one. FR-011 says a principal carrying no `environmentId` is
// refused; "the guard would have caught it" is an argument about today's decorator, and
// the clause is about the surface.

const page: RequestLogPage = {
  requests: [],
  next_cursor: null,
  prev_cursor: null,
  has_more: false,
  window: { from: "", to: "" },
  retention_edge: "",
};

const reader: RequestLogReaderPort = { page: () => Promise.resolve(page) };
const endpoints: EndpointSet = { get: () => new Set(["/v1/request-log"]) };
const controller = new RequestLogController(reader, endpoints);

const call = (principal: RequestWithTenant["principal"]) =>
  controller
    .page({ principal } as RequestWithTenant, {})
    .then(() => null)
    .catch((e: unknown) => e);

describe("the request-log controller's tenant requirement", () => {
  it.each([
    ["no principal at all", undefined],
    ["a principal with no environment — what `platform` carries by design", { kind: "platform" }],
    ["an empty environment id", { kind: "application", environmentId: "" }],
  ])("refuses %s with 403", async (_name, principal) => {
    const thrown = await call(principal as RequestWithTenant["principal"]);
    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(403);
    // A 403 AND NOT AN EMPTY PAGE. An empty page would say the tenant made no requests
    // when there is no tenant in the question at all.
    expect((thrown as HttpException).getResponse()).toMatchObject({ code: "forbidden" });
  });

  it("serves a principal that carries one", async () => {
    const thrown = await call({
      kind: "application",
      environmentId: "3f2a1b4c-5d6e-4f70-8192-a3b4c5d6e7f8",
    } as RequestWithTenant["principal"]);
    expect(thrown).toBeNull();
  });
});
