import {
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import {
  describePrincipalKind,
  type PrincipalKind,
  type RequestWithPrincipal,
} from "./principal";

const ACCEPTS = "relay:accepts";

/** What a route accepts, declared on the route (research R6). The default is
 * "either class", so a handler only says something when it is narrower than
 * that — and the narrow cases are the interesting ones: FR-AUT-09's dev-token
 * endpoint and FR-AUT-10's administrative operations want an API key
 * specifically, not merely a valid credential. */
export const Accepts = (...kinds: PrincipalKind[]) => SetMetadata(ACCEPTS, kinds);

const EITHER: PrincipalKind[] = ["application", "user"];

function expectation(kinds: PrincipalKind[]): string {
  return kinds.map(describePrincipalKind).join(" or ");
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
      this.reflector.getAllAndOverride<PrincipalKind[]>(ACCEPTS, [
        context.getHandler(),
        context.getClass(),
      ]) ?? EITHER;

    const req = context.switchToHttp().getRequest<RequestWithPrincipal>();
    const principal = req.principal;

    if (!principal) {
      throw new UnauthorizedException(
        `this route requires a credential: ${expectation(accepted)}, presented as "Authorization: Bearer …"`,
      );
    }

    if (!accepted.includes(principal.kind)) {
      throw new ForbiddenException({
        code: "wrong_credential_type",
        message: `this route expects ${expectation(accepted)}; ${describePrincipalKind(
          principal.kind,
        )} was presented`,
      });
    }

    return true;
  }
}
