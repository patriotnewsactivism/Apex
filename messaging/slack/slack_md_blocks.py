"""
slack_md_blocks.py — convert Markdown to Slack Block Kit blocks.

Slack added a ``markdown`` block type to Block Kit (2024+) that renders
standard Markdown natively, *including pipe-delimited tables*. The rest of
``slack_interface.py`` posts everything through ``slackify_markdown`` as a
single ``text`` field, which renders inline styling fine but leaves Markdown
tables as raw ``| col | col |`` text.

This module promotes a Markdown string to a list of Block Kit blocks when —
and only when — it contains a "rich" element (header, table, fenced code, or
horizontal rule). Otherwise it returns ``(None, md)`` so the caller falls back
to the existing plain ``slackify_markdown`` path with zero behavioural change.

Entry point:
    md_to_slack_blocks(md) -> (blocks | None, fallback_text)
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

# Slack header blocks use plain_text and are capped at 150 chars.
_HEADER_MAX = 150
# Slack section mrkdwn text is capped at 3000 chars; keep a safety margin.
_SECTION_MAX = 2900

# Cheap precheck: does the body contain anything worth promoting to blocks?
#   ^#         ATX header
#   ^|         table row (pipe)
#   ^```       fenced code block
#   ^---/***   horizontal rule
_RICH_PRECHECK = re.compile(r"^(#{1,6}\s|\||```|---\s*$|\*\*\*\s*$)", re.MULTILINE)

# A markdown table needs a header row of pipes AND a separator row of dashes.
_TABLE_SEPARATOR = re.compile(r"^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$")
_PIPE_ROW = re.compile(r"^\s*\|.*\|\s*$|^\s*[^|\n]*\|[^|\n]*$")

_ATX_HEADER = re.compile(r"^(#{1,6})\s+(.*?)\s*#*\s*$")
_HRULE = re.compile(r"^\s*(?:---+|\*\*\*+|___+)\s*$")


def _is_table_separator(line: str) -> bool:
    return bool(_TABLE_SEPARATOR.match(line))


def _looks_like_table_row(line: str) -> bool:
    """A line participates in a table if it contains a pipe character."""
    return "|" in line


def _clean_inline(text: str) -> str:
    """
    Light cleanup for fallback/notification text only — strip the most common
    Markdown markup so the notification preview reads as clean prose.

    NOTE: this is intentionally minimal; the rich rendering is done by Slack
    from the markdown block, not by us.
    """
    # Links [text](url) -> text
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    # Bold **x** / __x__ -> x
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"__([^_]+)__", r"\1", text)
    # Inline code `x` -> x
    text = re.sub(r"`([^`]+)`", r"\1", text)
    return text.strip()


def _md_to_mrkdwn(text: str) -> str:
    """
    Convert a small subset of Markdown inline syntax to Slack mrkdwn for use
    inside section blocks (paragraphs / lists).

      **bold**       -> *bold*
      [text](url)    -> <url|text>

    Italics and other constructs are left as-is; Slack tolerates them.
    """
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"<\2|\1>", text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"*\1*", text)
    return text


def _header_block(level_text: str) -> Dict:
    txt = level_text[:_HEADER_MAX]
    return {
        "type": "header",
        "text": {"type": "plain_text", "text": txt, "emoji": True},
    }


def _section_block(mrkdwn: str) -> Dict:
    return {
        "type": "section",
        "text": {"type": "mrkdwn", "text": mrkdwn[:_SECTION_MAX]},
    }


def _markdown_block(raw_md: str) -> Dict:
    """Slack's native markdown block — renders tables, etc."""
    return {"type": "markdown", "text": raw_md}


def _divider_block() -> Dict:
    return {"type": "divider"}


def md_to_slack_blocks(md: str) -> Tuple[Optional[List[Dict]], str]:
    """
    Convert Markdown -> Slack Block Kit blocks.

      - ``# headers``        -> header blocks
      - markdown tables      -> markdown blocks (Slack renders natively, 2024+)
      - fenced code          -> markdown blocks (``` retained)
      - horizontal rules     -> divider blocks
      - paragraphs / lists   -> section/mrkdwn (with bold + link cleanup)

    Returns ``(blocks, fallback_text)``. If no rich element is present,
    returns ``(None, md)`` so the caller falls back to today's plain path.
    """
    if not md or not _RICH_PRECHECK.search(md):
        return None, md

    lines = md.split("\n")
    blocks: List[Dict] = []
    fallback_parts: List[str] = []

    i = 0
    n = len(lines)
    para_buf: List[str] = []

    def flush_paragraph() -> None:
        if not para_buf:
            return
        text = "\n".join(para_buf).strip()
        if text:
            blocks.append(_section_block(_md_to_mrkdwn(text)))
            fallback_parts.append(_clean_inline(text))
        para_buf.clear()

    while i < n:
        line = lines[i]
        stripped = line.strip()

        # Blank line — paragraph break
        if not stripped:
            flush_paragraph()
            i += 1
            continue

        # Fenced code block
        if stripped.startswith("```"):
            flush_paragraph()
            code_lines = [line]
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i])
                i += 1
            if i < n:  # closing fence
                code_lines.append(lines[i])
                i += 1
            code_md = "\n".join(code_lines)
            blocks.append(_markdown_block(code_md))
            fallback_parts.append(_clean_inline("\n".join(code_lines[1:-1])))
            continue

        # Horizontal rule
        if _HRULE.match(stripped):
            flush_paragraph()
            blocks.append(_divider_block())
            i += 1
            continue

        # ATX header
        m = _ATX_HEADER.match(stripped)
        if m:
            flush_paragraph()
            blocks.append(_header_block(m.group(2)))
            fallback_parts.append(m.group(2))
            i += 1
            continue

        # Table: a pipe row immediately followed by a separator row
        if (
            _looks_like_table_row(line)
            and i + 1 < n
            and _is_table_separator(lines[i + 1])
        ):
            flush_paragraph()
            table_lines = [line, lines[i + 1]]
            i += 2
            while i < n and _looks_like_table_row(lines[i]) and lines[i].strip():
                table_lines.append(lines[i])
                i += 1
            table_md = "\n".join(table_lines)
            blocks.append(_markdown_block(table_md))
            fallback_parts.append(_clean_inline(table_md))
            continue

        # Regular paragraph / list line — accumulate
        para_buf.append(line)
        i += 1

    flush_paragraph()

    if not blocks:
        return None, md

    fallback_text = "\n\n".join(p for p in fallback_parts if p).strip() or md
    return blocks, fallback_text
