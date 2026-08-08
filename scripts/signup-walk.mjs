// Chapter 3.1's walk: sign up, and then sign up again.
//
// The first run creates an organisation, an application and a development
// environment from one authentication. The second run, with the same provider
// identity, creates nothing and hands back what already exists. Both are the
// same code path a reader points at GitHub — only the provider is local, so
// the walk needs no account and no network (research R8).
//
// The stand-in listens on a FIXED port, because the api has to be told where
// the provider is before it starts:
//
//   PROVIDER=http://127.0.0.1:4199
//   RELAY_OAUTH_GITHUB_CLIENT_ID=walk \
//   RELAY_OAUTH_GITHUB_CLIENT_SECRET=walk \
//   RELAY_OAUTH_GITHUB_TOKEN_URL=$PROVIDER/token \
//   RELAY_OAUTH_GITHUB_USER_URL=$PROVIDER/user \
//   RELAY_OAUTH_GITHUB_AUTHORIZE_URL=$PROVIDER/authorize \
//     node services/api/dist/main.js &
//   node scripts/signup-walk.mjs
import { createServer } from "node:http";

const API = process.env.RELAY_API_URL ?? "http://127.0.0.1:4000";

/** A stand-in GitHub: one token endpoint, one profile endpoint. */
const ACCOUNT_ID = process.env.RELAY_WALK_ACCOUNT ?? `walk-${Date.now()}`;
const provider = createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url?.startsWith("/token")) {
    res.end(JSON.stringify({ access_token: "gho_walk", token_type: "bearer" }));
    return;
  }
  res.end(JSON.stringify({ id: ACCOUNT_ID, login: "tuan", name: "Tuan" }));
});
const PROVIDER_PORT = Number(process.env.RELAY_WALK_PROVIDER_PORT ?? 4199);
await new Promise((resolve) => provider.listen(PROVIDER_PORT, resolve));
console.log(`stand-in provider on ${PROVIDER_PORT}, account ${ACCOUNT_ID}\n`);

/** Walk the flow the way a browser does: follow the redirect, keep the cookie,
 * come back with the state the server minted. */
async function signUp(label) {
  const start = await fetch(`${API}/auth/github/start`, { redirect: "manual" });
  const location = start.headers.get("location");
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0];
  console.log(`${label} → GET /auth/github/start`);
  console.log(`    ${start.status} redirect to ${location?.slice(0, 60)}…`);
  console.log(`    cookie: ${cookie?.split("=")[0]} (HttpOnly, SameSite=Lax)`);

  const state = new URL(location).searchParams.get("state");
  const res = await fetch(
    `${API}/auth/github/callback?code=walk-code&state=${state}`,
    { headers: { cookie } },
  );
  const body = await res.json();
  console.log(`${label} → GET /auth/github/callback`);
  console.log(`    ${res.status} created=${body.created}`);
  console.log(`    organisation ${body.organisation?.id}`);
  console.log(`    application  ${body.application?.id}`);
  console.log(
    `    environment  ${body.environment?.id} (${body.environment?.kind})\n`,
  );
  return body;
}

const first = await signUp("first authentication ");
const second = await signUp("second authentication");

console.log(
  first.organisation?.id === second.organisation?.id
    ? "same organisation both times — one identity, one workspace (FR-TEN-01/02)"
    : "DIFFERENT organisations — signup is not idempotent, which is a bug",
);

// And the state binding, refused: the value is real, the cookie is not sent.
const start = await fetch(`${API}/auth/github/start`, { redirect: "manual" });
const stolen = new URL(start.headers.get("location")).searchParams.get("state");
const forged = await fetch(
  `${API}/auth/github/callback?code=walk-code&state=${stolen}`,
);
console.log(
  `\nsame state, no cookie: ${forged.status} — the binding is what makes state work`,
);

provider.close();
process.exit(0);
