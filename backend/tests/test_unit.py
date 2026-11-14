"""Fast unit tests that do not need ffmpeg, a GPU, or model files."""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path

_TMP = tempfile.mkdtemp(prefix="rveweb-tests-")
os.environ.setdefault("DATA_DIR", _TMP)
os.environ.setdefault("MODEL_DIR", str(Path(_TMP) / "models"))
os.environ.setdefault("FRONTEND_DIR", str(Path(_TMP) / "frontend"))

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.catalog import INTERPOLATORS, UPSCALERS, model_catalog  # noqa: E402
from app.db import Database  # noqa: E402
from app.engine.ffmpeg import decode_filter  # noqa: E402
from app.schemas import JobSettings, parse_settings  # noqa: E402


class SchemaTests(unittest.TestCase):
    def test_defaults(self):
        settings = JobSettings()
        self.assertTrue(settings.upscale.enabled)
        self.assertTrue(settings.interpolate.enabled)
        self.assertEqual(settings.interpolate.model, "rife-4.27")
        self.assertEqual(settings.interpolate.factor, 2)

    def test_parse_roundtrip(self):
        raw = JobSettings().model_dump_json()
        parsed = parse_settings(raw)
        self.assertEqual(parsed.interpolate.factor, 2)
        self.assertEqual(parsed.encode.container, "mp4")

    def test_unknown_key_rejected(self):
        with self.assertRaises(ValueError):
            parse_settings('{"upscale":{"enabled":true,"model":"realesrgan-video","scale":2,"nope":1}}')

    def test_bad_scale_rejected(self):
        with self.assertRaises(ValueError):
            parse_settings('{"upscale":{"enabled":true,"model":"realesrgan-x4plus","scale":3}}')

    def test_bad_factor_rejected(self):
        with self.assertRaises(ValueError):
            parse_settings('{"interpolate":{"enabled":true,"model":"rife-4.27","factor":3}}')

    def test_bad_crf_rejected(self):
        with self.assertRaises(ValueError):
            parse_settings('{"encode":{"crf":5}}')


class CatalogTests(unittest.TestCase):
    def test_catalog_shape(self):
        catalog = model_catalog()
        self.assertEqual(len(catalog["upscalers"]), len(UPSCALERS))
        self.assertEqual(len(catalog["interpolators"]), len(INTERPOLATORS))
        self.assertTrue(any(item["id"] == "rife-4.27" for item in catalog["interpolators"]))

    def test_scales(self):
        self.assertEqual(UPSCALERS["realesrgan-video"].scales, (2, 3, 4))
        self.assertEqual(UPSCALERS["realesrgan-x4plus"].scales, (2, 4))


class FilterTests(unittest.TestCase):
    def test_filters(self):
        settings = JobSettings()
        self.assertEqual(decode_filter(settings), "")
        settings.denoise.enabled = True
        settings.denoise.strength = "strong"
        self.assertIn("hqdn3d=7:5:9:7", decode_filter(settings))
        settings.decompress.enabled = True
        settings.decompress.strength = "strong"
        filtergraph = decode_filter(settings)
        self.assertIn("deblock=filter=strong", filtergraph)
        self.assertNotIn("dering", filtergraph)

    def test_odd_dimensions_are_padded_not_cropped(self):
        from app.engine.ffmpeg import build_encode_command

        command = build_encode_command(321, 181, 24.0, JobSettings(), "/tmp/out.mp4")
        joined = " ".join(command)
        self.assertIn("pad=ceil(iw/2)*2:ceil(ih/2)*2", joined)
        self.assertNotIn("trunc(iw/2)*2", joined)


class DatabaseTests(unittest.TestCase):
    def setUp(self):
        self.db = Database(Path(tempfile.mkdtemp(prefix="rveweb-db-")) / "test.sqlite3")

    def _job(self, max_queue: int | None = None):
        return self.db.create_job(
            source={"name": "clip.mp4", "width": 320, "height": 180, "fps": 24, "duration": 1},
            settings=JobSettings().model_dump(),
            input_path=str(Path(_TMP) / "job" / "input.mp4"),
            thumb_path=None,
            max_queue=max_queue,
        )

    def test_queue_admission_is_atomic(self):
        first = self._job(max_queue=1)
        self.assertIsNotNone(first)
        self.assertIsNone(self._job(max_queue=1))
        self.assertEqual(self.db.queue_counts(), {"active": 0, "queued": 1})

    def test_create_and_public(self):
        job = self._job()
        self.assertEqual(job["status"], "queued")
        public = self.db.public_job(job)
        self.assertNotIn("input_path", public)
        self.assertNotIn("createdAtSort", public)
        self.assertTrue(public["id"].startswith("j_"))

    def test_claim_and_counts(self):
        first = self._job()
        self._job()
        self.assertEqual(self.db.queue_counts(), {"active": 0, "queued": 2})
        claimed = self.db.claim_next(1)
        self.assertIsNotNone(claimed)
        self.assertEqual(claimed["id"], first["id"])
        self.assertIsNone(self.db.claim_next(1))
        self.assertEqual(self.db.queue_counts(), {"active": 1, "queued": 1})

    def test_cancel_and_finish(self):
        job = self._job()
        self.db.claim_next(1)
        self.db.request_cancel(job["id"])
        self.assertTrue(self.db.cancel_requested(job["id"]))
        self.db.update_job(job["id"], status="cancelled", completed_at=1.0)
        self.assertEqual(self.db.queue_counts(), {"active": 0, "queued": 0})
        self.assertEqual(len(self.db.cleanup_expired(0)), 1)

    def test_queue_capacity_is_atomic(self):
        first = self.db.create_job(
            source={"name": "a.mp4"},
            settings=JobSettings().model_dump(),
            input_path=str(Path(_TMP) / "a" / "input.mp4"),
            thumb_path=None,
            max_queue=1,
        )
        self.assertIsNotNone(first)
        second = self.db.create_job(
            source={"name": "b.mp4"},
            settings=JobSettings().model_dump(),
            input_path=str(Path(_TMP) / "b" / "input.mp4"),
            thumb_path=None,
            max_queue=1,
        )
        self.assertIsNone(second)
        self.assertEqual(self.db.queue_counts(), {"active": 0, "queued": 1})

    def test_recover_interrupted(self):
        self._job()
        self.db.claim_next(1)
        self.assertEqual(self.db.recover_interrupted(), 1)
        self.assertEqual(self.db.queue_counts(), {"active": 0, "queued": 0})


if __name__ == "__main__":
    unittest.main()
