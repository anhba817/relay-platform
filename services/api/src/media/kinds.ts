// WHAT MAY BE UPLOADED, AND HOW BIG — FR-MED-02's first two refusals, in one place.
//
// ONE TABLE, READ BY BOTH. The refusal asks "is this type allowed" and the cap asks
// "how big may this kind be", and those are two questions about one fact. Two lists
// would disagree the first time somebody adds a format to one of them, and the way
// they would disagree is silent: a type allowed with no cap, or a cap for a type
// nothing accepts.

export type MediaKind = "image" | "audio" | "video";

/** The ten FR-MED-02 permits, each mapped to its kind. */
export const ALLOWED_TYPES: Readonly<Record<string, MediaKind>> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/ogg": "audio",
  "audio/wav": "audio",
  "video/mp4": "video",
  "video/webm": "video",
};

/** Per-kind caps, in bytes. FR-MED-02: image 10 MB, audio 25 MB, video 100 MB. */
export const KIND_CAPS: Readonly<Record<MediaKind, number>> = {
  image: 10 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  video: 100 * 1024 * 1024,
};

/** The kind a declared type belongs to, or `null` if the type is not allowed.
 *
 * ONE FUNCTION FOR BOTH REFUSALS, so a type that is not in the table can never reach
 * the size check and find no cap there.
 *
 * `Object.hasOwn`, AND IT IS NOT DEFENSIVENESS — IT WAS MEASURED. The first version
 * was `ALLOWED_TYPES[mimeType] ?? null`, and an object literal inherits from
 * `Object.prototype`, so `kindOf("constructor")` returned a FUNCTION. Truthy, so the
 * type refusal never fired; and then `KIND_CAPS[thatFunction]` is `undefined`, and
 * `bytes > undefined` is `false`, so the SIZE refusal never fired either.
 *
 * **One declared MIME type of `constructor` defeated both of FR-MED-02's first two
 * refusals**, at any size. TypeScript types this map `Record<string, MediaKind>` and
 * says the return is a `MediaKind`; the runtime disagreed. The test that found it was
 * written to check exactly this and went red on the first run. */
export function kindOf(mimeType: string): MediaKind | null {
  return Object.hasOwn(ALLOWED_TYPES, mimeType) ? ALLOWED_TYPES[mimeType]! : null;
}
