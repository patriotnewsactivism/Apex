#!/usr/bin/env python3
"""Transcribe a Slack audio/voice message to text.

Downloads the audio file via the event-cache ``/files/download`` endpoint, then
sends it to the LiteLLM transcription endpoint (ninja-transcribe). Prints the
transcript to stdout.

Usage:
    python messaging/slack/transcribe.py <event_id> <file_id>

Auth:
    ``ANTHROPIC_AUTH_TOKEN`` from settings.json (used by
    ``AgentEventCacheClient``).
    The LiteLLM API key is read via ``clients.litellm_client.get_config()``.

Exit codes:
    0  — transcript printed to stdout
    1  — missing argument, download failure, or transcription failure
"""

import sys

from clients.agent_event_cache_client import AgentEventCacheClient
from clients.litellm_client import (
    get_config,
    get_headers,
    litellm_request,
    resolve_model,
)
from messaging.message_utils import audio_upload_part


def transcribe(event_id: str, file_id: str) -> str:
    """Download the audio attachment and return the transcript.

    Args:
        event_id: Event UUID that owns the file.
        file_id: Platform-native file identifier (e.g. ``F07QWERTY1``).

    Returns:
        Transcript text string.

    Raises:
        RuntimeError: If the download or transcription request fails.
    """
    # --- auth ---
    cfg = get_config()

    # --- download audio via event-cache ---
    client = AgentEventCacheClient()
    audio_resp = client.download_file(event_id, file_id, timeout=60)

    # --- transcribe ---
    # Omit Content-Type so requests can set the multipart boundary itself —
    # get_headers() sets application/json, which makes the gateway see no file.
    headers = {k: v for k, v in get_headers().items() if k != "Content-Type"}

    # audio_upload_part uses the URL only for extension detection; the
    # /files/download path has none, so it falls through to Content-Type.
    transcription_resp = litellm_request(
        "POST",
        "/v1/audio/transcriptions",
        headers=headers,
        files={"file": audio_upload_part("", audio_resp)},
        data={"model": resolve_model("ninja-transcribe")},
        timeout=120,
    )

    if not transcription_resp.ok:
        raise RuntimeError(
            f"Transcription failed ({transcription_resp.status_code}): "
            f"{transcription_resp.text[:200]}"
        )

    text = transcription_resp.json().get("text", "")
    if not text:
        raise RuntimeError("Transcription returned empty text.")
    return text


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: transcribe.py <event_id> <file_id>", file=sys.stderr)
        sys.exit(1)

    try:
        print(transcribe(sys.argv[1], sys.argv[2]))
    except RuntimeError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)
