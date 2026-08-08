import {
  profileSchema,
  providerErrorSchema,
  tokenResponseSchema,
  type Profile,
} from "./oauth.schema";

// The authorization-code flow, by hand (chapter 3.1).
//
// No Passport, no strategy plugin. The flow is three steps and this chapter
// exists to teach them; a library would hide exactly the part the reader came
// for, and would add two dependencies to a service whose constitution says
// boring by design. Chapter 2.5 wired the WebSocket upgrade by hand for the
// same reason.
//
// Endpoints are configuration, not constants. That is what lets the test lane
// point at a local stand-in and stay offline and deterministic (2.1's
// two-lane gate, 2.8's no-flakes rule) — and it is also what a real
// deployment needs for GitHub Enterprise.

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind: "denied" | "unusable",
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export interface ProviderConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userUrl: string;
  scope: string;
}

const GITHUB_DEFAULTS = {
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  userUrl: "https://api.github.com/user",
  scope: "read:user user:email",
};

/** Configuration for a provider, or undefined when it is not set up. An
 * unconfigured provider is a 404 rather than a redirect into a broken flow. */
export function providerConfig(name: string): ProviderConfig | undefined {
  if (name !== "github") return undefined;
  const clientId = process.env.RELAY_OAUTH_GITHUB_CLIENT_ID;
  const clientSecret = process.env.RELAY_OAUTH_GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return undefined;
  return {
    clientId,
    clientSecret,
    authorizeUrl:
      process.env.RELAY_OAUTH_GITHUB_AUTHORIZE_URL ??
      GITHUB_DEFAULTS.authorizeUrl,
    tokenUrl:
      process.env.RELAY_OAUTH_GITHUB_TOKEN_URL ?? GITHUB_DEFAULTS.tokenUrl,
    userUrl: process.env.RELAY_OAUTH_GITHUB_USER_URL ?? GITHUB_DEFAULTS.userUrl,
    scope: GITHUB_DEFAULTS.scope,
  };
}

export function redirectUri(provider: string): string {
  const base = process.env.RELAY_OAUTH_REDIRECT_BASE ?? "http://localhost:4000";
  return `${base}/auth/${provider}/callback`;
}

/** Step one: where to send the browser. */
export function authorizeUrl(
  provider: string,
  config: ProviderConfig,
  state: string,
): string {
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri(provider));
  url.searchParams.set("scope", config.scope);
  url.searchParams.set("state", state);
  return url.toString();
}

/** Steps two and three: trade the code for a token, then ask who it belongs
 * to. Both responses are parsed; neither is trusted for its shape. */
export async function exchangeCodeForProfile(
  provider: string,
  config: ProviderConfig,
  code: string,
): Promise<Profile> {
  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri(provider),
    }),
  });
  if (!tokenRes.ok) {
    throw new ProviderError(
      `token endpoint answered ${tokenRes.status}`,
      "unusable",
    );
  }
  const tokenBody: unknown = await tokenRes.json();

  // The provider's own refusal is a 400 to our caller, not a 502: nothing is
  // broken, the person declined or the code expired.
  const denied = providerErrorSchema.safeParse(tokenBody);
  if (denied.success) {
    throw new ProviderError(denied.data.error, "denied");
  }
  const token = tokenResponseSchema.safeParse(tokenBody);
  if (!token.success) {
    throw new ProviderError(
      "token response did not match the contract",
      "unusable",
    );
  }

  const userRes = await fetch(config.userUrl, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${token.data.access_token}`,
      // GitHub rejects requests without one.
      "user-agent": "relay",
    },
  });
  if (!userRes.ok) {
    throw new ProviderError(
      `user endpoint answered ${userRes.status}`,
      "unusable",
    );
  }
  const profile = profileSchema.safeParse(await userRes.json());
  if (!profile.success) {
    throw new ProviderError("profile did not match the contract", "unusable");
  }
  return profile.data;
}
