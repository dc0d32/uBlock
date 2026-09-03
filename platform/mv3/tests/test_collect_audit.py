import importlib.util
from pathlib import Path
import unittest


MODULE_PATH = Path(__file__).parents[1] / "tools" / "collect_audit.py"
SPEC = importlib.util.spec_from_file_location("collect_audit", MODULE_PATH)
collect_audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collect_audit)


class WalRecordMatchesTabTest(unittest.TestCase):
    def test_accepts_only_records_for_target_tab(self):
        self.assertTrue(
            collect_audit.wal_record_matches_tab({"tabId": 42}, 42)
        )
        self.assertFalse(
            collect_audit.wal_record_matches_tab({"tabId": 41}, 42)
        )
        self.assertFalse(
            collect_audit.wal_record_matches_tab({}, 42)
        )

    def test_accepts_all_records_without_resolved_target(self):
        self.assertTrue(
            collect_audit.wal_record_matches_tab({"tabId": 41}, None)
        )
        self.assertTrue(
            collect_audit.wal_record_matches_tab({}, None)
        )


if __name__ == "__main__":
    unittest.main()
