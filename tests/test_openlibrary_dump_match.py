import gzip
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


def load_module():
    file = Path(__file__).resolve().parents[1] / "local-mac" / "openlibrary_dump_match.py"
    spec = importlib.util.spec_from_file_location("openlibrary_dump_match", file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


mod = load_module()
BOOK_ID = "11111111-1111-4111-8111-111111111111"


def line(kind, key, data):
    return "\t".join((kind, key, "1", "2026-10-31T00:00:00", json.dumps(data)))


class DumpMatchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.catalogue = self.root / "catalogue.json"
        self.catalogue.write_text(json.dumps({
            "format": "my-library-bulk-catalogue-v1",
            "books": [{
                "id": BOOK_ID, "title": "Example Book", "author": "Writer",
                "updated_at": "2026-10-01T10:00:00", "has_cover": False,
                "has_synopsis": False, "has_tags": False,
                "isbns": ["9780306406157"]
            }]
        }), encoding="utf-8")
        self.editions = self.root / "editions.txt.gz"
        self.works = self.root / "works.txt.gz"
        self.authors = self.root / "authors.txt.gz"
        self.write(self.editions, [
            line("/type/edition", "/books/OL102M", {
                "title": "Example Book", "isbn_13": ["9780306406157"],
                "works": [{"key": "/works/OL123W"}], "covers": [12345]
            }),
            line("/type/edition", "/books/OL999M", {
                "title": "Unrelated", "works": [{"key": "/works/OL999W"}]
            }),
        ])
        self.write(self.works, [
            line("/type/work", "/works/OL123W", {
                "title": "Example Book", "description": {"value": "A verified synopsis"},
                "subjects": ["Fantasy", "Adventure"], "authors": [
                    {"author": {"key": "/authors/OL42A"}}
                ], "covers": [987]
            })
        ])
        self.write(self.authors, [
            line("/type/author", "/authors/OL42A", {"name": "Writer"})
        ])

    @staticmethod
    def write(path, lines):
        with gzip.open(path, "wt", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")

    def match(self):
        return mod.build_matches(
            self.catalogue, self.editions, self.works, self.authors
        )

    def test_exact_isbn_and_author_recovers_work_description_and_edition_cover(self):
        report = self.match()
        self.assertEqual(report["counts"]["verified_matches"], 1)
        self.assertEqual(report["counts"]["editions_scanned"], 2)
        item = report["items"][0]
        self.assertEqual(item["book_id"], BOOK_ID)
        self.assertEqual(item["match_type"], "isbn_author")
        self.assertEqual(item["synopsis"], "A verified synopsis")
        self.assertEqual(item["tags"], ["Fantasy", "Adventure"])
        self.assertEqual(item["cover_id"], 12345)
        self.assertEqual(item["source_work"], "/works/OL123W")

    def test_unknown_author_never_autofills(self):
        payload = json.loads(self.catalogue.read_text())
        payload["books"][0]["author"] = "Unknown"
        self.catalogue.write_text(json.dumps(payload))
        report = self.match()
        self.assertEqual(report["counts"]["verified_matches"], 0)

    def test_repeated_verified_works_are_reported_not_guessed(self):
        self.write(self.works, [
            line("/type/work", "/works/OL123W", {
                "title": "Example Book", "description": "One",
                "authors": [{"author": {"key": "/authors/OL42A"}}]
            }),
            line("/type/work", "/works/OL234W", {
                "title": "Example Book", "description": "Two",
                "authors": [{"author": {"key": "/authors/OL42A"}}]
            })
        ])
        report = self.match()
        self.assertEqual(report["counts"]["verified_matches"], 0)
        self.assertEqual(report["counts"]["needs_review"], 1)

    def test_isbn_checksums_and_description_sanitizing(self):
        self.assertEqual(mod.isbn13("0-306-40615-2"), "9780306406157")
        self.assertEqual(mod.isbn13("9780306406157"), "9780306406157")
        self.assertEqual(mod.isbn13("9780306406158"), "")
        self.assertEqual(mod.desc("<p>Good <b>book</b></p>"), "Good book")
        self.assertEqual(mod.cover_id([-1, 1.3, 543]), 543)


if __name__ == "__main__":
    unittest.main()
