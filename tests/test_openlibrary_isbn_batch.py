import json
import sys
import tempfile
import unittest
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-mac"))

from openlibrary_isbn_batch import (
    analyze_search, batch_all, load_checkpoint, main, query_url, requested_isbns,
    TemporarySourceProblem,
)

ISBN1 = "9780306406157"
ISBN2 = "9780140328721"
ISBN3 = "9780061120084"


def record(book_id, isbns):
    return {"book_id": book_id, "title": "Novel " + book_id,
            "author": "Writer", "isbns": isbns,
            "candidates": [], "reason": "review_required"}


def search_document(work, identifiers):
    return {"key": work, "title": "Matched work", "author_name": ["Writer"],
            "isbn": identifiers, "cover_i": 123}


class FullISBNQueueTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.checkpoint = Path(self.tmp.name) / "batch.json"
        self.report_path = Path(self.tmp.name) / "second-pass-review.json"

    def tearDown(self):
        self.tmp.cleanup()

    def test_url_batches_isbn_query_and_strict_size(self):
        parsed = urllib.parse.urlparse(query_url([ISBN1, ISBN2]))
        query = urllib.parse.parse_qs(parsed.query)
        self.assertEqual(query["q"], ["isbn:(" + ISBN1 + " OR " + ISBN2 + ")"])
        self.assertIn("isbn", query["fields"][0])
        with self.assertRaises(ValueError):
            query_url([ISBN1] * 26)

    def test_dedup_and_all_isbns_per_book(self):
        rows = [record("a", [ISBN1, ISBN2]), record("b", [ISBN2, ISBN3]),
                record("c", ["not-an-isbn"])]
        self.assertEqual(requested_isbns(rows), [ISBN1, ISBN2, ISBN3])

    def test_batch_processes_entire_queue_without_manual_100_limit(self):
        rows = [record(str(i), [ISBN1, ISBN2, ISBN3][i % 3:i % 3 + 1])
                for i in range(3)]
        seen = []
        sleeps = []
        def request(url):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["q"][0]
            identifiers = [isbn for isbn in [ISBN1, ISBN2, ISBN3] if isbn in query]
            seen.append(identifiers)
            return {"numFound": len(identifiers), "docs": [
                search_document("/works/OL" + str(i + 1) + "W", [isbn])
                for i, isbn in enumerate(identifiers)
            ]}
        cache, done, total = batch_all(rows, self.checkpoint, size=2,
                                       request_fn=request, sleep_fn=sleeps.append)
        self.assertEqual((done, total), (3, 3))
        self.assertEqual(len(seen), 2)
        self.assertEqual(sleeps, [1.5])
        self.assertEqual(len(cache), 3)
        self.assertEqual(cache[ISBN1]["status"], "isbn_work_candidate")

        def must_not_call(url):
            raise AssertionError("Completed ISBN should never be queried again")
        cached, done, total = batch_all(rows, self.checkpoint, size=2,
                                        request_fn=must_not_call, sleep_fn=lambda _: None)
        self.assertEqual((done, total), (0, 0))
        self.assertEqual(cached, cache)

    def test_fuzzy_search_never_assigns_unverified_isbn(self):
        result = analyze_search([ISBN1], {"numFound": 1, "docs": [
            search_document("/works/OL1W", [ISBN2])
        ]})
        self.assertEqual(result[ISBN1]["status"], "isbn_no_candidate_in_search")
        self.assertEqual(result[ISBN1]["source_work"], "")

    def test_multiple_and_truncated_results_remain_uncertain(self):
        result = analyze_search([ISBN1], {"numFound": 2, "docs": [
            search_document("/works/OL1W", [ISBN1]),
            search_document("/works/OL2W", [ISBN1]),
        ]})
        self.assertEqual(result[ISBN1]["status"], "isbn_multiple_work_candidates")
        self.assertEqual(result[ISBN1]["source_work"], "")
        incomplete = analyze_search([ISBN1], {"numFound": 1000, "docs": [
            search_document("/works/OL1W", [ISBN1])
        ]})
        self.assertEqual(incomplete[ISBN1]["status"], "isbn_search_incomplete")

    def test_legacy_100_at_a_time_checkpoint_is_reused(self):
        path = Path(self.tmp.name) / "second-pass-review.isbn-batch-checkpoint.json"
        older = path.with_name("second-pass-review.isbn-checkpoint.json")
        older.write_text(json.dumps({
            ISBN1: {"status": "isbn_edition_candidate", "source_work": "/works/OL1W"}
        }), encoding="utf-8")
        calls = []
        def request(url):
            calls.append(url)
            return {"numFound": 1,
                    "docs": [search_document("/works/OL2W", [ISBN2])]}
        cache, done, total = batch_all(
            [record("book", [ISBN1, ISBN2])], path, size=25,
            request_fn=request, sleep_fn=lambda _: None,
        )
        self.assertEqual((done, total), (1, 1))
        self.assertEqual(len(calls), 1)
        self.assertNotIn(ISBN1, urllib.parse.unquote(calls[0]))
        self.assertEqual(cache[ISBN1]["status"], "isbn_edition_candidate")

    def test_network_interruption_preserves_checkpoint_and_resumes(self):
        rows = [record("a", [ISBN1, ISBN2, ISBN3])]
        calls = [0]
        def unreliable(url):
            calls[0] += 1
            if calls[0] == 2:
                raise TemporarySourceProblem("Please retry later")
            isbn = ([ISBN1, ISBN2, ISBN3])[calls[0] - 1]
            return {"numFound": 1,
                    "docs": [search_document("/works/OL1W", [isbn])]}
        with self.assertRaises(TemporarySourceProblem):
            batch_all(rows, self.checkpoint, size=1,
                      request_fn=unreliable, sleep_fn=lambda _: None)
        saved = load_checkpoint(self.checkpoint)
        self.assertEqual(list(saved), [ISBN1])
        remaining = []
        def resume(url):
            remaining.append(url)
            query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)["q"][0]
            value = ISBN2 if ISBN2 in query else ISBN3
            return {"numFound": 1,
                    "docs": [search_document("/works/OL1W", [value])]}
        cache, done, total = batch_all(rows, self.checkpoint, size=1,
                                       request_fn=resume, sleep_fn=lambda _: None)
        self.assertEqual((done, total), (2, 2))
        self.assertEqual(len(cache), 3)
        self.assertEqual(len(remaining), 2)

    def test_cli_works_without_any_network_or_massive_dump_rescan(self):
        initial = {
            "format": "my-library-openlibrary-second-pass-review-v1",
            "counts": {"needs_review": 1, "unresolved": 0},
            "review": [record("a", [])], "unresolved": [],
        }
        self.report_path.write_text(json.dumps(initial), encoding="utf-8")
        self.assertEqual(main(["--report", str(self.report_path)]), 0)
        result = json.loads(self.report_path.read_text())
        self.assertEqual(result["counts"]["isbn_batch_unique_checked"], 0)
        self.assertTrue(self.report_path.with_suffix(".csv").exists())
        self.assertFalse((Path(self.tmp.name) / "works.txt.gz").exists())


if __name__ == "__main__":
    unittest.main()
