import { z } from "zod";

// What a provider is allowed to say back (chapter 3.1). Two responses cross
// this boundary — the token exchange and the profile fetch — and both are
// parsed, not assumed.
//
// The habit is 1.3's and it has paid every time since: an unvalidated payload
// does not fail where it arrives, it fails three layers away as an `undefined`
// somebody has to trace back. Here the stakes are higher than usual, because
// the thing being parsed decides who a person is.

/** GitHub answers a failed exchange with HTTP 200 and an error body. Parsing
 * only the success shape would read `access_token: undefined` as a token. */
export const providerErrorSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
});

export const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

/** The profile, narrowed to what signup is allowed to want. FR-TEN-01 says
 * "providing no information beyond that granted by the provider" — so this
 * takes an id, a name if there is one, an email if the provider released one,
 * and nothing else. `id` arrives as a number from GitHub and a string from
 * Google; both become a string, because it is an opaque key here. */
export const profileSchema = z.object({
  id: z.union([z.string().min(1), z.number().int()]).transform(String),
  login: z.string().min(1).optional(),
  name: z.string().min(1).nullish(),
  email: z.string().email().nullish(),
});

export type TokenResponse = z.infer<typeof tokenResponseSchema>;
export type Profile = z.infer<typeof profileSchema>;
