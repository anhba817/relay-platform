/** The live fan-out's subject grammar (chapter 2.6, ADR-07).
 *
 * MOVED HERE IN CHAPTER 3.18, and the reason is the same one chapter 3.4 gave
 * when it moved the event spine's `subjectFor` into this package: a subject
 * grammar belongs where every party that uses it can agree on it. Until 3.18
 * the gateway was the only publisher, so the grammar could live beside the
 * client that spoke it. The api publishes now too, and the api cannot import
 * from a service.
 *
 * WHAT DID NOT MOVE. `createFanout` stays in the gateway: it holds two ioredis
 * connections and this package has exactly one dependency, `zod`. A client with
 * a socket does not belong in a package of schemas. `DEFAULT_REDIS_URL` did not
 * move either — it is declared in three service files, it is deployment
 * configuration rather than protocol, and consolidating one of three copies
 * into a shared package leaves a shared definition and two locals, which is
 * worse than three locals.
 *
 * The payload never needed moving. `Message` and `messageCreatedSchema` have
 * been in `frames.ts` since 2.2; the fan-out has always carried a wire frame's
 * payload rather than a shape of its own. */

/** One subject per channel: an instance receives only frames it can
 * actually deliver, and a pathological channel saturates its own subject
 * rather than every gateway's inbox.
 *
 * NOT `subjectFor`, which this function was called in the gateway. This package
 * already exports a `subjectFor` — `internal.ts`'s, for the event spine's
 * `events.{domain}.{action}.{env}` — and the two cannot share a name here. The
 * compiler said so the moment both were exported:
 *
 *     src/index.ts(12,1): error TS2308: Module "./internal.js" has already
 *     exported a member named 'subjectFor'.
 *
 * The spine's name is chapter 3.4's and is published; this one is new, so this
 * one moves. The collision is the same asymmetry the chapter has to explain
 * anyway: the spine's subject carries the tenant, the fan-out's carries only a
 * channel id, and putting them side by side is what made that visible. */
export function subjectForChannel(channelId: string): string {
  return `chan:${channelId}`;
}
