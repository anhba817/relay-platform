-- DR-09's SECOND HALF, IMPLEMENTED THREE FEATURES AFTER IT WAS FILED AS ABSENT.
--
-- The clause, whole: "Raw events shall be retained for 90 days; **daily aggregates for 25
-- months**." Chapter 4.2 filed 047-3 -- "no clause says how long metering history is kept" --
-- and 048-4 carried it, and both were quoting DR-10, which sits one row below DR-09 in the
-- same table. The clause had said 25 months the whole time.
--
-- AND IT DOES NOT CONTRADICT FR-003a. That decision reads "metering must not lose history
-- when raw events do", and 25 months against the raw 90 days honours it with room to spare:
-- the rollup outlives its source by roughly eight times. "No TTL" was never what FR-003a
-- asked for -- only "not the raw table's TTL".
--
-- `toDateTime(day)` and not `day`, because a `Date` column needs the same coercion
-- `0000_message_events.sql` records for its `DateTime64`: the server refuses the bare form
-- with BAD_TTL_EXPRESSION.
ALTER TABLE relay_analytics.daily_usage_billing
    MODIFY TTL toDateTime(day) + INTERVAL 25 MONTH
