import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "local-mac"))
from prepare_second_pass_text import (
    same_variant, select_proposals, hydrate, build_output, main,
)

BOOK_ID = "11111111-1111-4111-8111-111111111111"
WORK = "/works/OL15666800W"


def catalogue(*, synopsis=False, tags=False):
    return {
        "format": "my-library-bulk-catalogue-v1",
        "books": [{
            "id": BOOK_ID,
            "title": "The Sentinel Mage (The Cursed Kingdoms, #1)",
            "author": "Emily Gee",
            "updated_at": "2026-11-10T00:00:00.000Z",
            "has_synopsis": synopsis,
            "has_tags": tags,
            "has_cover": False,
            "isbns": [],
        }],
    }


def report(*, verified=True, reason="alternate_title_or_author_review",
           candidates=1):
    item = {
        "book_id": BOOK_ID, "title": "The Sentinel Mage (The Cursed Kingdoms, #1)",
        "author": "Emily Gee", "reason": reason,
        "candidates": [{
            "source_work": WORK,
            "source_title": "The Sentinel Mage",
            "title_method": "exact",
            "source_title_method": "primary",
            "author_verified": verified,
            "has_synopsis": True,
            "synopsis_preview": "The source begins this way",
            "tags": ["Magic", "Fantasy"],
            "cover_id": 12345,
        }] * candidates,
    }
    return {"format": "my-library-openlibrary-second-pass-review-v1",
            "review": [item], "unresolved": []}


class TextOnlySecondPassTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.catalogue_path = self.root / "catalogue.json"
        self.review_path = self.root / "review.json"
        self.output_path = self.root / "proposals.json"

    def tearDown(self):
        self.tmp.cleanup()

    def write_inputs(self, source_report=None, source_catalogue=None):
        self.catalogue_path.write_text(json.dumps(source_catalogue or catalogue()))
        self.review_path.write_text(json.dumps(source_report or report()))

    def test_source_variants_not_truncated_snapshots(self):
        self.assertTrue(same_variant(
            "The Sentinel Mage (The Cursed Kingdoms, #1)", "The Sentinel Mage"))
        self.assertTrue(same_variant(
            "The Borderlands of Science: Where Sense Meets Nonsense",
            "The Borderlands of Science"))
        self.assertFalse(same_variant("Another Different Book", "The Sentinel Mage"))

    def test_one_author_verified_variant_gets_text_only_review_proposal(self):
        self.write_inputs()
        from openlibrary_dump_match import read_catalogue
        rows, skipped = select_proposals(report(), self.catalogue_path)
        self.assertEqual(len(rows), 1)
        p = rows[0]
        self.assertTrue(p["title_variant_author_verified"])
        self.assertEqual(p["tags"], ["Magic", "Fantasy"])
        self.assertTrue(p["synopsis_pending"])
        self.assertEqual(p["synopsis"], "")
        self.assertIsNone(p["cover_id"])
        self.assertEqual(p["source_edition"], "")
        self.assertEqual(p["match_type"], "reviewed_title_variant")
        self.assertEqual(skipped, [])

    def test_ambiguous_or_unverified_candidates_never_selected(self):
        self.write_inputs()
        for candidate in (
            report(verified=False),
            report(reason="multiple_author_verified_works"),
            report(candidates=2),
        ):
            rows, _ = select_proposals(candidate, self.catalogue_path)
            self.assertFalse(rows)

    def test_owner_existing_fields_never_proposed_for_overwrite(self):
        self.write_inputs(source_catalogue=catalogue(synopsis=True, tags=False))
        rows, _ = select_proposals(report(), self.catalogue_path)
        self.assertFalse(rows[0]["synopsis_pending"])
        self.assertEqual(rows[0]["synopsis"], "")
        self.assertEqual(rows[0]["tags"], ["Magic", "Fantasy"])

    def test_resume_full_synopsis_from_checkpoint(self):
        from openlibrary_dump_match import read_catalogue
        self.write_inputs()
        rows, _ = select_proposals(report(), self.catalogue_path)
        calls = []
        def get(key, title, preview):
            calls.append(key)
            return "The source begins this way and continues with full description."
        checkpoint = self.root / "source-checkpoint.json"
        count, paused = hydrate(rows, checkpoint, getter=get,
                                sleep=lambda _: None, progress=lambda _: None)
        self.assertEqual((count, paused), (1, False))
        self.assertEqual(len(calls), 1)
        self.assertTrue(rows[0]["synopsis"].startswith("The source begins"))
        self.assertFalse(rows[0]["synopsis_pending"])
        rows2, _ = select_proposals(report(), self.catalogue_path)
        count, paused = hydrate(rows2, checkpoint,
                                getter=lambda *args: self.fail("Repeated lookup"),
                                sleep=lambda _: None, progress=lambda _: None)
        self.assertEqual((count, paused), (1, False))
        output = build_output(rows2, [])
        self.assertEqual(output["counts"]["synopses_recovered"], 1)
        self.assertEqual(output["items"][0]["synopsis"], rows[0]["synopsis"])

    def test_cli_generates_review_only_json_without_contacting_network(self):
        self.write_inputs()
        main(["--review", str(self.review_path), "--catalogue",
              str(self.catalogue_path), "--output", str(self.output_path)])
        output = json.loads(self.output_path.read_text())
        self.assertEqual(output["format"],
                         "my-library-openlibrary-second-pass-text-v1")
        self.assertEqual(output["counts"]["text_proposals"], 1)
        self.assertEqual(output["counts"]["synopses_still_pending"], 1)
        self.assertIsNone(output["items"][0]["cover_id"])


if __name__ == "__main__":
    unittest.main()
