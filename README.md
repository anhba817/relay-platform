# Relay — the platform

The canonical implementation of **Relay**, the chat-infrastructure platform built
chapter by chapter in the [Building Relay tutorial series](https://relay-tutorial.codewithdongly.io.vn).

## How this repository works

- **One git tag per chapter** (`part1-ch1`, `part1-ch2`, …). Every tag is a
  runnable, tested state: check it out and the toolchain checks pass. Each
  chapter's SKIP AHEAD box names the tag to check out if you get stuck.
- **The tutorial and this code cannot drift**: every command and file a chapter
  shows is verified against this repository at that chapter's tag.
- **One language, one toolchain** (ADR-01): TypeScript/Node across every
  package and service, one lint config, one test runner.

## The toolchain checks

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

All three checks pass at every chapter tag — that is the definition of a
chapter being done.

## Layout

- `packages/` — shared workspace packages (`@relay/config` today;
  `@relay/protocol` arrives in chapter 1.3)
- `services/` — the six Relay services (arriving from chapter 1.4 onward)
