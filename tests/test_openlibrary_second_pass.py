import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-mac"))
from openlibrary_second_pass import (
    title_variants, work_titles, scan_local, review_second_pass, load_previous,
    atomic_json, write_csv, normalize, main,
)


def book(book_id, title, author, *, synopsis=True, cover=True, tags=True):
    return {
        "id": book_id, "title": title, "author": author,
        "author_key": normalize(author),
        "needs_synopsis": synopsis, "needs_cover": cover, "needs_tags": tags,
        "isbns": [],
    }


def dump_line(kind, key, data):
    return "\t".join((kind, key, "1", "2026-10-31T00:00:00Z",
                       json.dumps(data))) + "\n"


class ReviewOnlyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.works = self.root / "works.txt"
        self.authors = self.root / "authors.txt"

    def tearDown(self):
        self.tmp.cleanup()

    def write_dumps(self, works, authors):
        with self.works.open("w", encoding="utf-8") as f:
            for index, w in enumerate(works, 1):
                f.write(dump_line("/type/work", f"/works/OL{index}W", w))
        with self.authors.open("w", encoding="utf-8") as f:
            for index, a in enumerate(authors, 1):
                f.write(dump_line("/type/author", f"/authors/OL{index}A", a))

    def test_conservative_title_variants(self):
        v = title_variants("The Moonward Library: A Novel")
        self.assertIn("the moonward library a novel", v)
        self.assertIn("the moonward library", v)
        self.assertNotIn("the", v)
        self.assertIn("source_alternate_title",
                      [method for title, method in work_titles(
                          {"title": "First Title",
                           "other_titles": ["Second Title"]})])

    def test_alternate_title_and_author_are_review_only(self):
        self.write_dumps(
            [{
                "title": "A Different Title",
                "other_titles": ["The Moonward Library"],
                "authors": [{"author": {"key": "/authors/OL1A"}}],
                "description": {"value": "Published synopsis"},
                "covers": [456],
                "subjects": ["Speculative fiction"],
            }],
            [{"name": "Pen Name", "alternate_names": ["R. C. Sadoff"]}],
        )
        books = [book("b1", "The Moonward Library: A Novel",
                      "R. C. Sadoff", synopsis=True)]
        cand, hits, names, wc, ac = scan_local(books, self.works, self.authors,
                                              progress=False)
        review, unresolved = review_second_pass(books, cand, hits, names)
        self.assertEqual((wc, ac), (1, 1))
        self.assertEqual(len(review), 1)
        self.assertFalse(unresolved)
        self.assertEqual(review[0]["reason"],
                         "alternate_title_or_author_review")
        self.assertEqual(review[0]["candidates"][0]["source_work"],
                         "/works/OL1W")
        self.assertTrue(review[0]["candidates"][0]["author_verified"])
        self.assertTrue(review[0]["candidates"][0]["provides_missing_data"])

    def test_ambiguous_same_title_and_author_not_auto_matched(self):
        works = [
            {"title": "The Glass Conservatory",
             "authors": [{"author": {"key": "/authors/OL1A"}}],
             "description": "First synopsis"},
            {"title": "The Glass Conservatory",
             "authors": [{"author": {"key": "/authors/OL1A"}}],
             "description": "Second synopsis"}
        ]
        self.write_dumps(works, [{"name": "A. Writer"}])
        books = [book("b1", "The Glass Conservatory",
                      "A. Writer", synopsis=True)]
        cand, hits, names, *_ = scan_local(books, self.works, self.authors,
                                         progress=False)
        review, unresolved = review_second_pass(books, cand, hits, names)
        self.assertEqual(review[0]["reason"], "multiple_author_verified_works")
        self.assertFalse(unresolved)

    def test_no_useful_metadata_is_not_reported_as_usable(self):
        self.write_dumps([{
            "title": "Silent Reading Circle",
            "authors": [{"author": {"key": "/authors/OL1A"}}]
        }], [{"name": "Pen Name"}])
        books = [book("b1", "Silent Reading Circle", "Pen Name",
                      cover=True, synopsis=True, tags=True)]
        cand, hits, names, *_ = scan_local(books, self.works, self.authors,
                                         progress=False)
        review, unresolved = review_second_pass(books, cand, hits, names)
        self.assertFalse(review)
        self.assertEqual(unresolved[0]["reason"],
                         "matched_but_no_missing_metadata_available")

    def test_title_only_does_not_verify_wrong_author(self):
        self.write_dumps([{
            "title": "Silent Reading Circle",
            "authors": [{"author": {"key": "/authors/OL1A"}}],
            "covers": [44]
        }], [{"name": "Different Writer"}])
        books = [book("b1", "Silent Reading Circle", "Pen Name", cover=True)]
        cand, hits, names, *_ = scan_local(books, self.works, self.authors,
                                         progress=False)
        review, unresolved = review_second_pass(books, cand, hits, names)
        self.assertEqual(review[0]["reason"],
                         "title_candidate_author_unverified")
        self.assertFalse(review[0]["candidates"][0]["author_verified"])
        self.assertFalse(unresolved)


    def test_isbn_only_reuses_saved_report_without_dump_scans(self):
        report_path = self.root / "second-pass.json"
        atomic_json(report_path, {
            "format": "my-library-openlibrary-second-pass-review-v1",
            "counts": {"isbn_online_requests": 0},
            "review": [{
                "book_id": "book-id", "title": "Example Book", "author": "Writer",
                "isbns": [], "reason": "title_candidate_author_unverified",
                "candidates": [],
            }],
            "unresolved": []
        })
        main(["--isbn-only", "--isbn-lookups", "1",
              "--output", str(report_path)])
        result = json.loads(report_path.read_text())
        self.assertEqual(result["counts"]["isbn_online_requests"], 0)
        self.assertTrue(report_path.with_suffix(".csv").exists())
        self.assertFalse(self.works.exists())
        self.assertFalse(self.authors.exists())

    def test_preserve_first_pass_and_write_review_files_only(self):
        previous = self.root / "first.json"
        atomic_json(previous, {
            "format": "my-library-openlibrary-matches-v1",
            "items": [{"book_id": "b1"}, {"book_id": "b2"}]
        })
        self.assertEqual(load_previous(previous), {"b1", "b2"})
        report_path = self.root / "review.json"
        csv_path = self.root / "review.csv"
        atomic_json(report_path, {"format":
                    "my-library-openlibrary-second-pass-review-v1",
                    "review": [], "unresolved": []})
        write_csv(csv_path, [])
        self.assertIn("review", json.loads(report_path.read_text()))
        self.assertTrue(csv_path.read_text(encoding="utf-8-sig")
                        .startswith("book_id,title,author"))
        self.assertEqual(load_previous(previous), {"b1", "b2"})


if __name__ == "__main__":
    unittest.main()
