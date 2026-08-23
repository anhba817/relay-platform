import {
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";

import { protocolError } from "../protocol-error";
import { Reflector } from "@nestjs/core";

import type { PlatformService } from "./authenticate.middleware";
import {
  describePrincipalKind,
  OVER_AUTH_THRESHOLD,
  type RequestWithPrincipal,
} from "./principal";

const ACCEPTS = "relay:accepts";

/** What a route accepts (research R6, narrowed by chapter 3.12's FR-044).
 *
 * A tenant class is named by its own name. A PLATFORM credential must additionally
 * name the services allowed, because there are two of them and they are not equally
 * exposed — the gateway terminates connections from the public internet and the
 * dispatcher does not. Chapter 3.11 gave each its own secret and stopped there, so
 * both still resolved to one class and the gateway's credential reached every
 * dispatch route, including `replay`, whose handler takes a dead-letter id and no
 * environment.
 *
 * `@Accepts("platform")` DOES NOT COMPILE, and that is the point. An authorization
 * that can be omitted is one that will be, and the omission is invisible: the route
 * works, the tests pass, and the blast radius is one leaked secret wide. */
export type AcceptSpec =
  | "application"
  | "user"
  | { readonly platform: readonly PlatformService[] };

export const Accepts = (...specs: AcceptSpec[]) => SetMetadata(ACCEPTS, specs);

const EITHER: AcceptSpec[] = ["application", "user"];

function isPlatformSpec(
  spec: AcceptSpec,
): spec is { readonly platform: readonly PlatformService[] } {
  return typeof spec === "object";
}

/** What the 401 and the 403 say a route wanted.
 *
 * `AcceptSpec` broke this and nothing in an earlier draft of chapter 3.12 fixed it:
 * two client-visible strings are built from it, and widening the decorator's type
 * without widening theirs leaves the part an integrator actually reads behind. The
 * platform case names its services, because "an internal platform credential" is
 * true of the one that was just refused. */
function expectation(specs: readonly AcceptSpec[]): string {
  return specs
    .map((spec) =>
      isPlatformSpec(spec)
        ? `${describePrincipalKind("platform")} for ${spec.platform.join(" or ")}`
        : describePrincipalKind(spec),
    )
    .join(" or ");
}

/** The guard that used to be `EnvironmentContextGuard` (2.2), doing a smaller
 * job. It no longer resolves anything — the middleware did that, from a
 * credential rather than from a header the caller asserted — so all that is left
 * is the question a guard can actually answer: may THIS class of credential use
 * THIS route?
 *
 * The two refusals it produces are the chapter's subject:
 *
 *   401 — nothing valid was presented. Absent and invalid are the same answer.
 *   403 `wrong_credential_type` — a perfectly good credential of the wrong kind.
 *
 * The 403's message names the CLASS presented and the class expected, and never
 * the credential: "the key rk_dev_abc… is not valid" is how a live secret ends
 * up in a support ticket (NFR-SEC-06, research R9).
 */
@Injectable()
export class CredentialGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const accepted =
      this.reflector.getAllAndOverride<AcceptSpec[]>(ACCEPTS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? EITHER;

    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = req.principal;

    // Chapter 3.8 (FR-AUT-12, FR-RTL-02, research R18). The refusal for an
    // over-threshold address is thrown HERE and not in the middleware that
    // counted it, because `AuthenticateMiddleware` never throws by documented
    // design — pre-credential routes reach their handlers by having no principal.
    //
    // Three things fall out of putting it here. The invariant survives verbatim.
    // Both refusals come from one place, which is what EIR-API-04 needs: a caller
    // must not be able to tell a rate-limited refusal from a wrong-credential
    // one, or the limiter becomes an oracle. And the guard already throws the
    // object form that carries a `code`, which is what the envelope needs.
    //
    // BEFORE the principal check, so an address over its allowance is refused
    // whether or not the credential it just presented would have worked.
    if (req[OVER_AUTH_THRESHOLD] === true) {
      throw protocolError(
        "rate_limited",
        "too many failed authentication attempts from this address; retry shortly",
        429,
      );
    }

    if (!principal) {
      throw new UnauthorizedException(
        `this route requires a credential: ${expectation(accepted)}, presented as "Authorization: Bearer …"`,
      );
    }

    const matchingKind = accepted.filter((spec) =>
      isPlatformSpec(spec) ? principal.kind === "platform" : spec === principal.kind,
    );

    if (matchingKind.length === 0) {
      throw protocolError(
        "wrong_credential_type",
        `this route expects ${expectation(accepted)}; ${describePrincipalKind(
          principal.kind,
        )} was presented`,
        403,
      );
    }

    // FR-044. The class is right; the question left is whether THIS SERVICE may
    // call this route. Two platform credentials exist and `service` says which one
    // answered — a fact chapter 3.11 recorded as being "for logs", which is where
    // the gap was: a field nothing enforces is a field nothing protects.
    //
    // `principal.service` is a `string` and the permitted list is a union of the
    // services that exist. The widening cast is here rather than on the principal
    // because `principal.ts` must not import from the middleware that builds it —
    // the dependency runs the other way — so the narrowing happens at the one place
    // that compares them.
    if (principal.kind === "platform") {
      const permitted = matchingKind
        .filter(isPlatformSpec)
        .flatMap((spec) => spec.platform as readonly string[]);
      if (!permitted.includes(principal.service)) {
        throw protocolError(
          "wrong_credential_service",
          `"${principal.service}" is not permitted on this route ` +
            `(${permitted.join(" or ")})`,
          403,
        );
      }
    }

    return true;
  }
}
