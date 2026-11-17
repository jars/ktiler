import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "migration", Path(__file__).resolve().parents[1] / "scripts/migrate-shortcuts.py"
)
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


class FakeKDE:
    def __init__(self):
        self.bindings = {}
        for index, suffix in enumerate(migration.SUFFIXES):
            self.bindings[("kwin", "KDETiler-" + suffix, "KWin", "old")] = (
                () if suffix == "SpreadResize" else ((100 + index, 0, 0, 0),)
            )
            self.bindings[("kwin", "ktiler-" + suffix, "KWin", "new")] = ()
        self.bindings[("kwin", "Window Close", "KWin", "unrelated")] = ((999, 0, 0, 0),)
        self.reject = None

    def actions(self):
        return list(self.bindings)

    def keys(self, action):
        return self.bindings[tuple(action)]

    def set_keys(self, action, keys):
        self.bindings[tuple(action)] = () if action[1] == self.reject else tuple(keys)

    def owner(self, key):
        return next((action for action, keys in self.bindings.items() if tuple(key) in keys), ())


class MigrationTests(unittest.TestCase):
    def test_transfer_scoped_and_idempotent(self):
        api = FakeKDE()
        plan = migration.plan_transfer(api)
        self.assertEqual(len(plan), 25)
        migration.transfer(api, plan)
        for old, new, keys in plan:
            self.assertEqual(api.keys(old), ())
            self.assertEqual(api.keys(new), keys)
        self.assertEqual(api.keys(("kwin", "Window Close", "KWin", "unrelated")), ((999, 0, 0, 0),))
        self.assertEqual(migration.plan_transfer(api), [])

    def test_preserves_custom_multikey_sequences(self):
        api = FakeKDE()
        old = api.actions()[0]
        api.bindings[old] = ((100, 200, 0, 0), (300, 0, 0, 0))
        plan = migration.plan_transfer(api)
        migration.transfer(api, plan)
        self.assertEqual(api.keys(plan[0][1]), ((100, 200, 0, 0), (300, 0, 0, 0)))

    def test_custom_target_conflict_is_rejected_before_any_write(self):
        api = FakeKDE()
        target = api.actions()[1]
        api.bindings[target] = ((777, 0, 0, 0),)
        before = dict(api.bindings)
        with self.assertRaises(RuntimeError):
            migration.plan_transfer(api)
        self.assertEqual(api.bindings, before)

    def test_failed_assignment_rolls_back_targeted_bindings(self):
        api = FakeKDE()
        before = dict(api.bindings)
        plan = migration.plan_transfer(api)
        api.reject = plan[4][1][1]
        with self.assertRaises(RuntimeError):
            migration.transfer(api, plan)
        self.assertEqual(api.bindings, before)

    def test_zero_filled_unbound_keys(self):
        self.assertEqual(migration.normalize(((0, 0, 0, 0),)), ())


if __name__ == "__main__":
    unittest.main()
