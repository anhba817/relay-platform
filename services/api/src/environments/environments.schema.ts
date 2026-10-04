import { z } from "zod";

/** FR-MOD-06's four options, as a request body.
 *
 * **`z.strictObject`, WHICH IS THE CLAUSE RATHER THAN A STYLE.** Constitution VI's
 * fifth bullet is a MUST — *"Input is validated against a schema before processing;
 * unknown fields are rejected on write endpoints"* — and a `z.object` would accept
 * `{"retention_days": 30, "retentionDays": 90}` and silently apply one of them. It is
 * the convention here already: `channels.schema.ts` uses it seven times and
 * `messages.schema.ts` four.
 *
 * **`null` IS INDEFINITE AND AN ABSENT KEY IS NOT.** FR-MOD-06's fourth option is
 * *indefinite*, and `environments.retention_days` has spelled that as the absence of a
 * value since chapter 2.1. A client clearing a policy sends `null` explicitly; a client
 * omitting the field changes nothing. **They are different requests**, which is chapter
 * 4.14's lesson about an absent key and a null value being the same to a truthiness
 * check and different to a contract — so this is `.optional()` over a `.nullable()`
 * member rather than one `.nullish()`, and the handler reads `"retention_days" in body`
 * rather than testing the value.
 *
 * THE THREE INTEGERS ARE A LITERAL UNION AND NOT A RANGE. The clause enumerates them,
 * so `45` is not a stricter policy somebody chose — it is a value nothing licenses, and
 * `environments_retention_days_check` refuses it at the database too. Two places, and
 * the schema is the one that produces a 400 rather than a 500. */
export const patchEnvironmentSchema = z.strictObject({
  retention_days: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]).optional(),
});

export type PatchEnvironment = z.infer<typeof patchEnvironmentSchema>;
