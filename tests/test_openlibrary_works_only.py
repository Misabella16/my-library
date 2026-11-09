#!/usr/bin/env python3
"""Small synthetic fixtures for the Works + Authors matcher.

Run from repo root:
python3 -m unittest discover -s tests -p 'test_openlibrary_works_only.py' -v
"""
import gzip
import importlib.util
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-mac"))
from openlibrary_works_only import match_works_only, save_matched_cache  # noqa: E402


def dump(path, entries):
    with gzip.open(path, "wt", encoding="utf-8") as f:
        for record_type, key, obj in entries:
            f.write("\t".join([record_type, key, "0", "0", json.dumps(obj)]) + "\n")


def target(uuid, title="The Star Archive", author="A. Writer", synopsis=False, cover=False, tags=False):
    return {
        "id": uuid,
        "title": title,
        "author": author,
        "updated_at": "2026-11-09T13:00:00Z",
        "has_synopsis": synopsis,
        "has_cover": cover,
        "has_tags": tags,
        "isbns": ["9780306406157"],
    }


class WorksOnlyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.works, self.authors = base / "works.txt.gz", base / "authors.txt.gz"
        self.catalogue = base / "catalogue.json"
        self.book_id = "11111111-1111-4111-8111-111111111111"
        self.books = [target(self.book_id)]
        self.work_records = [
            ("/type/work", "/works/OL123W", {
                "title": "The Star Archive",
                "authors": [{"author": {"key": "/authors/OL9A"}}],
                "description": {"type": "/type/text", "value": "A useful description."},
                "subjects": ["Fantasy", "Space Opera"],
                "covers": [345],
            })
        ]
        self.author_records = [
            ("/type/author", "/authors/OL9A", {"name": "A. Writer"})
        ]

    def run_match(self):
        self.catalogue.write_text(json.dumps({
            "format": "my-library-bulk-catalogue-v1", "books": self.books
        }), encoding="utf-8")
        dump(self.works, self.work_records)
        dump(self.authors, self.author_records)
        return match_works_only(self.catalogue, self.works, self.authors)

    def test_verified_exact_title_and_author_yields_website_compatible_report(self):
        report = self.run_match()
        self.assertEqual(report["format"], "my-library-openlibrary-matches-v1")
        self.assertEqual(report["counts"]["verified_matches"], 1)
        item = report["items"][0]
        self.assertEqual(item["book_id"], self.book_id)
        self.assertEqual(item["source_work"], "/works/OL123W")
        self.assertEqual(item["source_edition"], "")
        self.assertEqual(item["match_type"], "title_author")
        self.assertEqual(item["cover_id"], 345)
        self.assertEqual(item["synopsis"], "A useful description.")
        self.assertEqual(item["tags"], ["Fantasy", "Space Opera"])

    def test_same_title_wrong_author_is_never_accepted(self):
        self.books[0]["author"] = "Another Person"
        report = self.run_match()
        self.assertEqual(report["counts"]["verified_matches"], 0)
        self.assertEqual(report["counts"]["unmatched"], 1)

    def test_alias_of_author_is_valid(self):
        self.author_records[0][2]["alternate_names"] = ["A. Writer", "Alex Writer"]
        self.books[0]["author"] = "Alex Writer"
        report = self.run_match()
        self.assertEqual(report["counts"]["verified_matches"], 1)

    def test_several_works_with_same_title_author_require_review(self):
        self.work_records.append(("/type/work", "/works/OL555W", {
            "title": "The Star Archive",
            "authors": [{"author": {"key": "/authors/OL9A"}}],
            "description": "Another work with same title and writer",
        }))
        report = self.run_match()
        self.assertEqual(report["counts"]["verified_matches"], 0)
        self.assertEqual(report["counts"]["needs_review"], 1)

    def test_existing_fields_are_not_proposed_again(self):
        self.books[0]["has_synopsis"] = True
        self.books[0]["has_cover"] = True
        self.books[0]["has_tags"] = False
        report = self.run_match()
        self.assertEqual(report["counts"]["verified_matches"], 1)
        item = report["items"][0]
        self.assertEqual(item["synopsis"], "")
        self.assertIsNone(item["cover_id"])
        self.assertEqual(item["tags"], ["Fantasy", "Space Opera"])

    def test_all_fields_already_present_are_skipped(self):
        self.books[0].update(has_synopsis=True, has_cover=True, has_tags=True)
        report = self.run_match()
        self.assertEqual(report["counts"]["books_needing_data"], 0)
        self.assertEqual(report["counts"]["verified_matches"], 0)

    def test_sqlite_cache_contains_only_verified_matching_metadata(self):
        report = self.run_match()
        filename = Path(self.temp.name) / "verified.sqlite"
        save_matched_cache(filename, report)
        with sqlite3.connect(filename) as db:
            rows = db.execute("SELECT book_id,source_work,cover_id FROM openlibrary_work_matches").fetchall()
        self.assertEqual(rows, [(self.book_id, "/works/OL123W", 345)])
        self.books[0]["author"] = "Wrong Author"
        save_matched_cache(filename, self.run_match())
        with sqlite3.connect(filename) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM openlibrary_work_matches").fetchone()[0], 0)

    def test_missing_cover_or_description_does_not_invent_them(self):
        self.work_records[0][2].pop("covers")
        self.work_records[0][2].pop("description")
        report = self.run_match()
        self.assertEqual(report["items"][0]["synopsis"], "")
        self.assertIsNone(report["items"][0]["cover_id"])


if __name__ == "__main__":
    unittest.main()
