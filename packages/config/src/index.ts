// @relay/config — the workspace's shared constants, and the designated home
// for lint/test fragments as packages multiply. The compiler baseline itself
// lives once at the repository root (tsconfig.base.json); packages extend it
// by relative path — one home per rule, never copies (chapter 1.1's TRAP).

export const NODE_VERSION_RANGE = ">=22.12";

export const WORKSPACE_GLOBS = ["packages/*", "services/*"] as const;

export const TOOLCHAIN_CHECKS = ["lint", "typecheck", "test"] as const;
