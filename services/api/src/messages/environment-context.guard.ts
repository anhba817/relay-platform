import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";

// DECISION (chapter 2.2): real credentials arrive with Part 3 (API keys
// in 3.2, tenancy in 3.1). Until then, public routes name their tenant
// via the X-Relay-Environment header — a dev-mode seam, load-bearing for
// exactly as long as it takes Part 3 to replace it. The guard resolves
// the header; the request-scoped Repository below it is what makes the
// scoping real (constitution I).
@Injectable()
export class EnvironmentContextGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | undefined>;
      environmentId?: string;
    }>();
    const environmentId = req.headers["x-relay-environment"];
    if (!environmentId) {
      throw new UnauthorizedException("missing X-Relay-Environment");
    }
    req.environmentId = environmentId;
    return true;
  }
}
