import tempfile
import unittest
from pathlib import Path
from unittest import mock

import collectors
import server

HOUR = server.HOUR_MS
DAY = server.DAY_MS
NOW = 1_000 * DAY + 12 * HOUR  # midday, day 1000
SETTINGS = {"enabled": True, "rawDays": 30, "hourlyDays": 365}


def frame(ts_ms, sol=10.0, usdc=2.0):
    return {
        "ts_ms": ts_ms, "currency": "USD",
        "sources": [{
            "id": "wallet", "label": "Wallet", "value": sol + usdc,
            "holdings": [
                {"id": "sol", "symbol": "SOL", "value": sol},
                {"id": "usdc", "symbol": "USDC", "value": usdc, "kind": "cash"},
            ],
        }],
    }


class RetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "test.sqlite3")
        server.migrate(self.db)

    def tearDown(self):
        self.temp.cleanup()

    def holding_times(self, start, end):
        with server.connect(self.db) as db:
            return sorted({row[0] for row in db.execute(
                "SELECT ts_ms FROM holdings_history WHERE ts_ms >= ? AND ts_ms < ?", (start, end))})

    def poll_every(self, start, end, step):
        for index, ts in enumerate(range(start, end, step)):
            server.ingest(self.db, frame(ts, sol=10 + index % 7))

    def test_recent_polls_are_all_kept(self):
        start = NOW - 2 * DAY
        self.poll_every(start, NOW, 10 * 60_000)
        before = self.holding_times(0, NOW + 1)
        self.assertEqual(server.prune(self.db, NOW, SETTINGS)["deleted"], 0)
        self.assertEqual(self.holding_times(0, NOW + 1), before)

    def test_older_than_raw_days_keeps_the_last_poll_of_each_hour(self):
        day = ((NOW - 60 * DAY) // DAY) * DAY
        self.poll_every(day, day + 3 * HOUR, 15 * 60_000)
        result = server.prune(self.db, NOW, SETTINGS)
        self.assertEqual(result["deleted"], 2 * 9)  # 12 polls x 2 holdings, 3 kept polls x 2
        self.assertEqual(self.holding_times(0, NOW), [day + 45 * 60_000, day + HOUR + 45 * 60_000, day + 2 * HOUR + 45 * 60_000])
        with server.connect(self.db) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM portfolio_samples").fetchone()[0], 12, "totals are never thinned")

    def test_older_than_hourly_days_keeps_the_last_poll_of_each_day(self):
        day = ((NOW - 400 * DAY) // DAY) * DAY
        self.poll_every(day, day + 2 * DAY, 4 * HOUR)
        server.prune(self.db, NOW, SETTINGS)
        self.assertEqual(self.holding_times(0, NOW), [day + 20 * HOUR, day + DAY + 20 * HOUR])

    def test_scope_filtered_history_is_unchanged_at_the_resolution_finance_uses(self):
        hourly_day = ((NOW - 90 * DAY) // DAY) * DAY
        daily_day = ((NOW - 500 * DAY) // DAY) * DAY
        self.poll_every(hourly_day, hourly_day + 5 * HOUR, 20 * 60_000)
        self.poll_every(daily_day, daily_day + 3 * DAY, 3 * HOUR)
        excluded = {("wallet", "sol")}
        before_hourly = server.history(self.db, hourly_day, hourly_day + DAY, "1h", excluded)
        before_daily = server.history(self.db, daily_day, daily_day + 3 * DAY, "1d", excluded)
        server.prune(self.db, NOW, SETTINGS)
        self.assertEqual(server.history(self.db, hourly_day, hourly_day + DAY, "1h", excluded), before_hourly)
        self.assertEqual(server.history(self.db, daily_day, daily_day + 3 * DAY, "1d", excluded), before_daily)
        self.assertTrue(all(point["v"] == 2 for point in before_hourly + before_daily), "SOL is subtracted")

    def test_pruning_twice_changes_nothing_more(self):
        day = ((NOW - 60 * DAY) // DAY) * DAY
        self.poll_every(day, day + 2 * HOUR, 10 * 60_000)
        server.prune(self.db, NOW, SETTINGS)
        self.assertEqual(server.prune(self.db, NOW, SETTINGS)["deleted"], 0)

    def test_retention_can_be_turned_off(self):
        day = ((NOW - 60 * DAY) // DAY) * DAY
        self.poll_every(day, day + 2 * HOUR, 10 * 60_000)
        self.assertEqual(server.prune(self.db, NOW, {**SETTINGS, "enabled": False})["deleted"], 0)
        self.assertEqual(len(self.holding_times(0, NOW)), 12)

    def test_vacuum_runs(self):
        day = ((NOW - 60 * DAY) // DAY) * DAY
        self.poll_every(day, day + 2 * HOUR, 10 * 60_000)
        server.prune(self.db, NOW, SETTINGS, vacuum=True)
        self.assertEqual(server.integrity_check(self.db), "ok")

    def test_backup_is_a_complete_consistent_copy(self):
        self.poll_every(NOW - HOUR, NOW, 10 * 60_000)
        out = str(Path(self.temp.name) / "backups" / "copy.sqlite3")
        result = server.backup(self.db, out)
        self.assertGreater(result["bytes"], 0)
        self.assertEqual(server.integrity_check(out), "ok")
        self.assertEqual(server.history(out, 0, NOW, "raw"), server.history(self.db, 0, NOW, "raw"))
        with self.assertRaises(ValueError):
            server.backup(self.db, out)

    def test_settings_come_from_the_environment(self):
        self.assertEqual(server.retention_settings({}), {"enabled": True, "rawDays": 30, "hourlyDays": 365})
        self.assertEqual(
            server.retention_settings({"ATMOS_PORTFOLIO_RAW_DAYS": "14", "ATMOS_PORTFOLIO_HOURLY_DAYS": "90"}),
            {"enabled": True, "rawDays": 14, "hourlyDays": 90},
        )
        self.assertEqual(server.retention_settings({"ATMOS_PORTFOLIO_RAW_DAYS": "60", "ATMOS_PORTFOLIO_HOURLY_DAYS": "10"})["hourlyDays"], 60)
        self.assertEqual(server.retention_settings({"ATMOS_PORTFOLIO_RAW_DAYS": "soon"})["rawDays"], 30)
        self.assertFalse(server.retention_settings({"ATMOS_PORTFOLIO_RETENTION": "off"})["enabled"])

    def test_collector_prunes_on_start_and_then_every_few_hours(self):
        calls = []
        clock = iter([0, 0, 60, 60, server.PRUNE_INTERVAL_SECONDS + 1, server.PRUNE_INTERVAL_SECONDS + 1])

        class Stop(Exception):
            pass

        sleeps = []

        def sleep(_seconds):
            sleeps.append(_seconds)
            if len(sleeps) == 3:
                raise Stop()

        with mock.patch.object(collectors, "load_config", return_value={"poll_seconds": 60}), \
             mock.patch.object(collectors, "collect_once"), \
             mock.patch.object(collectors.server, "prune", side_effect=lambda db: calls.append(db) or {"deleted": 0}), \
             mock.patch.object(collectors.time, "monotonic", side_effect=lambda: next(clock)), \
             mock.patch.object(collectors.time, "sleep", side_effect=sleep):
            with self.assertRaises(Stop):
                collectors.run("config.json", self.db)
        self.assertEqual(calls, [self.db, self.db])

    def test_a_failing_prune_does_not_stop_collection(self):
        with mock.patch.object(collectors.server, "prune", side_effect=RuntimeError("disk full")):
            collectors._prune(self.db)  # logs, does not raise


if __name__ == "__main__":
    unittest.main()
