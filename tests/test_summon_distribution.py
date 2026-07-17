"""Consistency and safety checks for Summon's private delivery layer."""

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_private_marketplace_identity():
    plugin = json.loads((ROOT / ".claude-plugin/plugin.json").read_text())
    marketplace = json.loads((ROOT / ".claude-plugin/marketplace.json").read_text())
    assert plugin["name"] == "summon-seo"
    assert marketplace["name"] == "summon-seo"
    assert marketplace["owner"]["name"] == "Summon"
    assert marketplace["plugins"][0]["name"] == plugin["name"]
    assert plugin["author"]["name"] == "Summon"
    assert marketplace["plugins"][0]["author"]["name"] == "Summon"


def test_summon_skill_assets_and_references_exist():
    skill = ROOT / "skills/summon-seo-service"
    text = (skill / "SKILL.md").read_text()
    for name in (
        "intake.md",
        "audit-brief.md",
        "opportunity-backlog.md",
        "implementation-brief.md",
        "monthly-report.md",
        "qa-checklist.md",
    ):
        assert (skill / "assets/templates" / name).is_file()
    for name in ("delivery-standards.md", "travel-seo-playbook.md"):
        assert (skill / "references" / name).is_file()
        assert name in text


def test_google_connector_skill_declares_read_only_dependency():
    text = (ROOT / "skills/seo-google-performance/SKILL.md").read_text()
    assert "read-only" in text.lower()
    assert "Summon Google Performance organization connector" in text
    assert "Refuse any request to mutate" in text


def test_connector_tool_surface_has_no_mutation_tools():
    source = (ROOT / "services/summon-google-performance-mcp/server.mjs").read_text()
    tool_block = source[source.index("const tools = [") : source.index("async function handleRpcRequest")]
    names = re.findall(r'^\s+name:\s+"([^"]+)"', tool_block, re.MULTILINE)
    assert names
    assert not any(re.search(r"mutate|update|create|delete", name, re.I) for name in names)
    assert "ALLOW_MULTITENANT" in source
