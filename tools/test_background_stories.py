from pathlib import Path
import json
import re
import tempfile
import unittest

from build_background_stories import (
    build_catalog,
    build_id_lookup,
    build_library_lookup,
    load_library_index,
    parse_source,
    resolve_document,
)


ROOT = Path(__file__).resolve().parent.parent
DATA_JS = ROOT / "铺面查看器/player/static/background-stories-data.js"
INDEX = ROOT / "铺面查看器/player/static/index.html"
STYLE = ROOT / "铺面查看器/player/static/style.css"


class BackgroundStories(unittest.TestCase):
    def test_multiple_research_versions_are_preserved_by_id(self):
        first = """# notes
## 1. Same Song
**曲目档案**
- 曲名：Same Song
- 艺术家：Artist A
- 统一曲库 ID：`arcade_123`
- BPM：120
**背景知识**
First version.
**核验边界**
First caveat.
"""
        second = """## 1. Same Song (revised heading)
**曲目档案**
标题：Same Song
艺人：Artist B
统一曲库 ID：`arcade:123`
谱面：EXT 9
**背景知识**
Second version.
**资料来源**
Source B.
"""
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            one = root / "one.md"
            two = root / "two.md"
            one.write_text(first, encoding="utf-8")
            two.write_text(second, encoding="utf-8")
            catalog = build_catalog(
                [one, two],
                [{"id": "arcade_123", "title": "Same Song", "version": "jubeat"}],
            )
        records = catalog["records"]
        self.assertEqual(catalog["recordCount"], 1)
        self.assertEqual(catalog["documentCount"], 2)
        documents = records["arcade_123"]["documents"]
        self.assertEqual(
            [item["title"] for item in documents],
            ["Same Song", "Same Song (revised heading)"],
        )
        self.assertEqual(
            [item["sections"][0]["text"] for item in documents],
            ["First version.", "Second version."],
        )
        self.assertEqual(documents[0]["sections"][1]["text"], "First caveat.")
        self.assertEqual(
            [item["mappingMethod"] for item in documents],
            ["stable-id", "stable-id"],
        )

    def test_hash_and_bold_sections_are_preserved(self):
        source = """# notes
## 1. Song
### 曲目档案
- 曲名：Song
- 统一曲库 ID：`arcade_1`
### 背景
Paragraph one.

#### 引用边注
Paragraph two.
"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "source.md"
            path.write_text(source, encoding="utf-8")
            document = parse_source(path)[0]
        self.assertEqual([item["title"] for item in document["sections"]], ["背景", "引用边注"])
        self.assertIn("Paragraph two.", document["sections"][1]["text"])

    def test_initial_document_uses_three_level_numbered_song_headings(self):
        source = """# initial
## 1. Group heading
### 1-1. First Song
#### 曲目档案
- 曲名：First Song
- 统一曲库 ID：`arcade:10000001`
#### 背景
Text.
"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "01_jubeat_初代歌曲背景.md"
            path.write_text(source, encoding="utf-8")
            documents = parse_source(path)
        self.assertEqual(len(documents), 1)
        self.assertEqual(documents[0]["order"], "1-1")
        self.assertEqual(documents[0]["id"], "arcade_10000001")

    def test_exact_title_and_version_mapping_is_unique(self):
        document = {
            "stableIds": [],
            "sourceVersion": "jubeat-ripples",
            "titleCandidates": ["Example Song"],
            "invalidIdClaim": False,
        }
        lookup = build_library_lookup(
            [
                {"id": "arcade_1", "title": "Example Song", "version": "jubeat-ripples"},
                {"id": "arcade_2", "title": "Example Song", "version": "jubeat-knit"},
            ]
        )
        self.assertEqual(resolve_document(document, lookup), ("arcade_1", "title-and-version"))

    def test_ambiguous_title_is_not_guessed(self):
        document = {
            "stableIds": [],
            "sourceVersion": "jubeat-ripples",
            "titleCandidates": ["Example Song"],
            "invalidIdClaim": False,
        }
        lookup = build_library_lookup(
            [
                {"id": "arcade_1", "title": "Example Song", "version": "jubeat-ripples"},
                {"id": "arcade_2", "title": "Example Song", "version": "jubeat-ripples"},
            ]
        )
        song_id, reason = resolve_document(document, lookup)
        self.assertIsNone(song_id)
        self.assertIn("ambiguous exact title", reason)

    def test_ave_research_number_is_not_treated_as_song_id(self):
        source = """# Ave.
## 1. First Song
**曲目档案**
- 曲名：First Song
- 统一曲库 ID：`0`
**背景知识**
Text.
"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "11_jubeat_Ave.歌曲背景.md"
            path.write_text(source, encoding="utf-8")
            catalog = build_catalog([path])
        self.assertEqual(catalog["recordCount"], 0)
        self.assertEqual(catalog["unresolvedCount"], 1)
        self.assertIn("non-stable ID claim ignored", catalog["issues"][0]["reason"])

    def test_unresolved_documents_are_retained_with_reason(self):
        source = """# ripple
## 4. Unknown Song
### 曲目档案
- 曲名：Unknown Song
- 统一曲库 ID：本地索引未检索到，未猜测 ID
### 背景
Research remains available.
"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "02_jubeat_ripples歌曲背景.md"
            path.write_text(source, encoding="utf-8")
            catalog = build_catalog([path])
        self.assertEqual(catalog["recordCount"], 0)
        self.assertEqual(catalog["unresolvedDocuments"][0]["title"], "Unknown Song")
        self.assertIn(
            "Research remains available.",
            catalog["unresolvedDocuments"][0]["sections"][0]["text"],
        )
        self.assertIn("no exact unique title", catalog["issues"][0]["reason"])

    def test_library_index_normalizes_arcade_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "index.json"
            path.write_text(
                json.dumps(
                    [{"identity": "arcade:123", "title": "Song", "version": "jubeat"}],
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            entries = load_library_index(path)
        self.assertEqual(entries[0]["id"], "arcade_123")

    def test_library_index_loads_version_shards(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            versions = root / "data/versions"
            versions.mkdir(parents=True)
            (versions / "plus.json").write_text(
                json.dumps(
                    {
                        "songs": [
                            {
                                "id": "jubeat-plus/首次收录/16_jubeat_plus_100000712",
                                "title": "Endless Chain",
                                "version": "jubeat-plus",
                            }
                        ]
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            index = root / "data/library.json"
            index.write_text(
                json.dumps(
                    {
                        "songs": [],
                        "versionIndexes": ["data/versions/plus.json"],
                    }
                ),
                encoding="utf-8",
            )
            entries = load_library_index(index)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["id"], "16_jubeat_plus_100000712")
        self.assertEqual(entries[0]["title"], "Endless Chain")
        self.assertEqual(entries[0]["version"], "jubeat-plus")
        self.assertIn("16_jubeat_plus_100000712", entries[0]["aliases"])

    def test_explicit_plus_china_and_video_ids_resolve(self):
        entries = [
            {
                "id": "16_jubeat_plus_100000712",
                "title": "Endless Chain",
                "version": "jubeat-plus",
            },
            {
                "id": "jubeatchina_990000001",
                "title": "Dash Dash Groovy Rush!!!",
                "version": "音乐魔方",
            },
            {
                "id": "C017",
                "title": "Celestial Axis",
                "version": "音乐魔方",
            },
        ]
        document = {
            "stableIds": [],
            "sourceVersion": "音乐魔方",
            "titleCandidates": ["Celestial Axis"],
            "invalidIdClaim": False,
        }
        by_title = build_library_lookup(entries)
        by_id = build_id_lookup(entries)
        cases = {
            "16_jubeat_plus_100000712": (
                "16_jubeat_plus_100000712",
                "stable-id",
            ),
            "jubeatchina_990000001": (
                "jubeatchina_990000001",
                "stable-id",
            ),
            "C017": ("C017", "stable-id"),
        }
        for stable_id, expected in cases.items():
            document["stableIds"] = [stable_id]
            lookup = (by_title, by_id)
            self.assertEqual(resolve_document(document, lookup), expected)

    def test_missing_explicit_id_can_use_only_an_exact_unique_title(self):
        entries = [
            {
                "id": "arcade_50000214",
                "title": "カラフルミニッツ [ 2 ]",
                "version": "jubeat-beyond-ave",
            }
        ]
        document = {
            "stableIds": ["arcade_11001002"],
            "sourceVersion": "jubeat-beyond-ave",
            "titleCandidates": ["カラフルミニッツ [ 2 ]"],
            "invalidIdClaim": False,
        }
        lookup = (build_library_lookup(entries), build_id_lookup(entries))
        self.assertEqual(
            resolve_document(document, lookup),
            ("arcade_50000214", "exact-title-over-stale-id"),
        )

    def test_missing_explicit_bracketed_id_can_use_a_unique_base_title(self):
        entries = [
            {
                "id": "arcade_30000107",
                "title": "君をのせて feat.sayurina [ 2 ]",
                "version": "jubeat-prop",
            }
        ]
        # This simulates a local library that exposes only the changed chart's
        # title while an older research draft still carries the base-song ID.
        document = {
            "stableIds": ["arcade_60001010"],
            "sourceVersion": "jubeat-prop",
            "titleCandidates": ["君をのせて feat.sayurina [ 2 ]"],
            "containsBracketedChart": True,
            "invalidIdClaim": False,
        }
        lookup = (build_library_lookup(entries), build_id_lookup(entries))
        self.assertEqual(
            resolve_document(document, lookup),
            ("arcade_30000107", "exact-title-over-stale-id"),
        )

        entries[0]["title"] = "君をのせて feat.sayurina"
        lookup = (build_library_lookup(entries), build_id_lookup(entries))
        self.assertEqual(
            resolve_document(document, lookup),
            ("arcade_30000107", "base-title-over-stale-id"),
        )

    def test_missing_china_id_never_falls_back_to_an_exact_video_title(self):
        entries = [
            {
                "id": "C032",
                "title": "Wildfire",
                "version": "音乐魔方",
            }
        ]
        document = {
            "stableIds": ["jubeatchina_991000006"],
            "sourceVersion": "音乐魔方",
            "titleCandidates": ["Wildfire"],
            "invalidIdClaim": False,
        }
        lookup = (build_library_lookup(entries), build_id_lookup(entries))
        song_id, reason = resolve_document(document, lookup)
        self.assertIsNone(song_id)
        self.assertIn("explicit ID not found", reason)

    def test_bracketed_chart_prefers_its_own_library_entry(self):
        document = {
            "stableIds": [],
            "sourceVersion": "jubeat-beyond-ave",
            "titleCandidates": ["New Decade [ 2 ]"],
            "invalidIdClaim": False,
        }
        lookup = build_library_lookup(
            [
                {
                    "id": "arcade_11000001",
                    "title": "New Decade",
                    "version": "jubeat-beyond-ave",
                },
                {
                    "id": "arcade_11001003",
                    "title": "New Decade [ 2 ]",
                    "version": "jubeat-beyond-ave",
                },
            ]
        )
        self.assertEqual(
            resolve_document(document, lookup),
            ("arcade_11001003", "title-and-version"),
        )

    def test_bracketed_chart_falls_back_without_losing_article(self):
        source = """# beyond
## 1. New Decade [ 2 ]
**曲目档案**
- 曲名：New Decade [ 2 ]
**背景知识**
This is the independent HOLD-chart article.
"""
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "12_jubeat_beyond_the_Ave.歌曲背景.md"
            path.write_text(source, encoding="utf-8")
            catalog = build_catalog(
                [path],
                [
                    {
                        "id": "arcade_11000001",
                        "title": "New Decade",
                        "version": "jubeat-beyond-ave",
                    }
                ],
            )
        document = catalog["records"]["arcade_11000001"]["documents"][0]
        self.assertEqual(document["mappingMethod"], "base-title-and-version")
        self.assertEqual(document["title"], "New Decade [ 2 ]")
        self.assertIn("independent HOLD-chart", document["sections"][0]["text"])

    def test_checked_in_catalog_has_sources_mapping_and_unresolved_visibility(self):
        source = DATA_JS.read_text(encoding="utf-8")
        match = re.search(r"const data=(.*);\n  return data;", source, re.S)
        self.assertIsNotNone(match)
        catalog = json.loads(match.group(1))
        self.assertEqual(catalog["schemaVersion"], 2)
        self.assertEqual(catalog["sourceDocuments"], 16)
        self.assertEqual(catalog["documentCount"], 2449)
        self.assertEqual(catalog["recordCount"], 2430)
        self.assertEqual(catalog["mappedDocumentCount"], 2437)
        self.assertEqual(catalog["unresolvedCount"], 12)
        self.assertEqual(
            catalog["documentCount"],
            catalog["mappedDocumentCount"] + catalog["unresolvedCount"],
        )
        self.assertNotIn("C032", catalog["records"])
        self.assertNotIn("jubeatchina_991000006", catalog["records"])
        self.assertIn(
            "Wildfire",
            [item["title"] for item in catalog["unresolvedDocuments"]],
        )
        self.assertEqual(
            set(catalog["documentCountsBySourceVersion"]),
            {
                "jubeat",
                "jubeat-ripples",
                "jubeat-knit",
                "jubeat-copious",
                "jubeat-saucer",
                "jubeat-saucer-fulfill",
                "jubeat-prop",
                "jubeat-qubell",
                "jubeat-clan",
                "jubeat-festo",
                "jubeat-ave",
                "jubeat-beyond-ave",
                "jubeat-plus",
                "音乐魔方",
            },
        )
        for song_id, record in catalog["records"].items():
            self.assertEqual(record["id"], song_id)
            self.assertTrue(record["documents"])
        self.assertTrue(
            any(
                "核验" in section["title"]
                for record in catalog["records"].values()
                for doc in record["documents"]
                for section in doc["sections"]
            )
        )

    def test_viewer_assets_default_hidden_and_load_before_app(self):
        html = INDEX.read_text(encoding="utf-8")
        self.assertRegex(
            html,
            r'<button id="btnBackgroundStory"[^>]*hidden>背景故事</button>',
        )
        data_pos = html.index("background-stories-data.js")
        module_pos = html.index("background-stories.js")
        app_pos = html.index("static/app-base.js")
        self.assertLess(data_pos, module_pos)
        self.assertLess(module_pos, app_pos)

    def test_long_story_titles_cannot_expand_the_dialog_grid(self):
        style = STYLE.read_text(encoding="utf-8")
        self.assertRegex(
            style,
            r"\.story-dialog\[open\]\s*\{[^}]*grid-template-columns:minmax\(0,1fr\)",
        )
        self.assertRegex(
            style,
            r"\.story-dialog-title h2\s*\{[^}]*overflow-wrap:anywhere",
        )
        self.assertRegex(
            style,
            r"\.story-dialog-head\s*\{[^}]*min-width:0",
        )
        self.assertRegex(
            style,
            r"\.story-dialog-body\s*\{[^}]*min-width:0",
        )


if __name__ == "__main__":
    unittest.main()
