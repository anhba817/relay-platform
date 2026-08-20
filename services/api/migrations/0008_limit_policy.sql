-- Chapter 3.8 — per-environment rate limit policy (FR-RTL-04, FR-RTL-04).
--
-- NULLABLE, AND NULL IS NOT ZERO. A null column means "no override, use the
-- documented default", resolved at read time. A zero means "refuse everything",
-- which has to stay expressible — an environment can be switched off
-- deliberately — so the absent state and the refuse-everything state cannot
-- share a representation.
--
-- ON `environments` RATHER THAN IN A TABLE OF ITS OWN. FR-RTL-04's independence
-- is per environment, there is exactly one row per environment with no history
-- and no versioning, and a separate table would be a join for a value read on
-- every request.
--
-- The shape has a slot for an environment and NONE FOR A ROUTE, which forecloses
-- SRS Appendix C question 5 — whether the dev-token endpoint should be limited
-- more aggressively than the rest of its environment. That question stays open
-- and this is why (research R30).

ALTER TABLE environments
  ADD COLUMN rest_limit_per_minute    integer,
  ADD COLUMN send_limit_per_minute    integer,
  ADD COLUMN connect_limit_per_minute integer;

ALTER TABLE environments
  ADD CONSTRAINT environments_rest_limit_non_negative
    CHECK (rest_limit_per_minute IS NULL OR rest_limit_per_minute >= 0),
  ADD CONSTRAINT environments_send_limit_non_negative
    CHECK (send_limit_per_minute IS NULL OR send_limit_per_minute >= 0),
  ADD CONSTRAINT environments_connect_limit_non_negative
    CHECK (connect_limit_per_minute IS NULL OR connect_limit_per_minute >= 0);
