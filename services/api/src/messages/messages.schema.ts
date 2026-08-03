import { z } from "zod";

// The send body (chapter 2.2). FR-MSG-01 fixes the limits: text up to
// 8,000 characters, metadata up to 4 KB of JSON — the length check lands
// with FR-EMJ-02's code-point counting in the emoji chapter; today the
// character bound is the honest approximation, recorded as such.
export const sendMessageBodySchema = z.strictObject({
  text: z.string().min(1).max(8000),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Chapter 2.3 (FR-MSG-04): the client's idempotency key — minted at send
  // time (FR-SDK-06), optional because server-originated messages may not
  // carry one. The partial unique index (DR-03) ignores NULLs.
  idempotency_key: z.string().uuid().optional(),
});

export type SendMessageBody = z.infer<typeof sendMessageBodySchema>;
