"""The offline desktop bundle must retain price evidence, including zero."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('rate_generator', Path(__file__).resolve().parents[1] / 'scripts/gen-rates.py')
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


class RateGenerationTests(unittest.TestCase):
    def build(self, cost):
        return generator.build({'synthetic': {'models': {'model': {'cost': cost}}}})['synthetic']['model']

    def test_missing_cache_prices_are_distinct_from_explicit_zero(self):
        missing = self.build({'input': 2, 'output': 4})
        zero = self.build({'input': 2, 'output': 4, 'cache_read': 0, 'cache_write': 0})
        self.assertEqual(missing, [2, 4, 2, None, 1])
        self.assertEqual(zero, [2, 4, 0, 0, 7])

    def test_tier_metadata_is_retained_instead_of_claiming_flat_coverage(self):
        """Retain both supported context-tier forms in generated pricing evidence."""
        for extra in [{'tiers': [{'tier': {'size': 200000, 'type': 'context'}, 'input': 4}]},
                      {'context_over_200k': {'input': 4}}]:
            row = self.build({'input': 2, 'output': 4, 'cache_read': .5, **extra})
            self.assertEqual(row[4], 2)  # explicit read price, unresolved tier

    def test_fully_supported_flat_cache_prices_keep_their_evidence(self):
        self.assertEqual(self.build({'input': 2, 'output': 4, 'cache_read': .5, 'cache_write': 3}),
                         [2, 4, .5, 3, 7])
