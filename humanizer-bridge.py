#!/usr/bin/env python
"""humanizer-bridge.py — Node <-> humanizer_framework bridge for career-ops.

career-ops is a Node project; the communication framework is Python. This
CLI is the seam: Node (lib/humanizer.mjs) or an agent spawns it, passes a
goal or a draft, and reads exactly one JSON object from stdout.

Commands:
  write      --goal TEXT [--context-file F] [--dialogue-file F] [--rule R]...
             Generate a validated outgoing text through the framework's
             fallback chain (OpenCode -> GLM -> OpenAI API).
  validate   [--text TEXT | --text-file F | stdin] [--dialogue-file F]
             Offline pass: normalize + validate a draft. No LLM call.
  selfcheck  Report framework import, chain legs, key and persona file
             availability. No LLM call.

Persona: --voice-md (default voice-dna.md next to this script) is converted
into a bounded VoiceProfile (description digest + banned-list items as
`avoid`). Keys come from the framework's own .env — this script never
reads, stores or prints them. Any failure prints {"ok": false, "error": ...}
and exits 1.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

VOICE_DESC_CAP = 2400
VOICE_AVOID_CAP = 24
ASSISTANT_ROLES = {"assistant", "me", "bot", "seller", "agent", "я", "бот"}
MESSAGE_TYPES = ["outreach", "application", "chat_reply", "follow_up", "scheduling", "objection"]

ROOT = Path(__file__).resolve().parent


def _emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False))


def _die(message: str) -> None:
    _emit({"ok": False, "error": message})
    raise SystemExit(1)


def _read_text(path: str | None) -> str | None:
    if path:
        try:
            return Path(path).read_text(encoding="utf-8")
        except OSError as exc:
            _die(f"cannot read {path}: {exc}")
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return None


def _read_json(path: str | None):
    if not path:
        return None
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        _die(f"cannot read JSON from {path}: {exc}")


def _load_voice(path: Path):
    """voice-dna.md -> bounded VoiceProfile; missing file = no persona."""
    try:
        from humanizer_framework import VoiceProfile
    except ImportError:
        return None
    if not path.is_file():
        return None
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if not text:
        return None
    avoid: list[str] = []
    in_banned = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            in_banned = stripped.startswith("## 3")
            continue
        if in_banned and stripped.startswith("- "):
            item = stripped[2:].strip()
            if item:
                avoid.append(item)
    return VoiceProfile(
        id="career-ops-voice",
        description=text[:VOICE_DESC_CAP],
        avoid=avoid[:VOICE_AVOID_CAP],
    )


def _issue(issue) -> dict:
    return {"code": issue.code, "hard": issue.hard}


def cmd_write(args) -> None:
    from humanizer_framework import write

    result = write(
        args.goal,
        channel=args.channel,
        domain="job_search",
        message_type=args.type,
        language=args.language,
        profile=args.profile,
        facts=_read_json(args.context_file) or {},
        dialogue=_read_json(args.dialogue_file) or [],
        business_rules=args.rule or [],
        voice=_load_voice(Path(args.voice_md)),
    )
    _emit(
        {
            "ok": True,
            "text": result.text,
            "provider": result.provider,
            "rewritten": result.rewritten,
            "issues": [_issue(i) for i in result.issues],
        }
    )


def cmd_validate(args) -> None:
    from humanizer_framework import CommunicationFramework, Message, job_search_request
    from humanizer_framework.validators import normalize_output, validate_output

    draft = args.text or _read_text(args.text_file)
    if not draft or not draft.strip():
        _die("empty draft: pass --text, --text-file or pipe text on stdin")

    turns = [
        Message(
            "assistant" if str(role).strip().lower() in ASSISTANT_ROLES else "user",
            str(content),
        )
        for role, content in (_read_json(args.dialogue_file) or [])
    ]
    request = job_search_request(
        channel=args.channel,
        message_type=args.type,
        profile=args.profile,
        language=args.language,
        conversation=[*turns, Message("assistant", draft.strip())],
    )
    package = CommunicationFramework().prepare(request)
    normalized = normalize_output(draft.strip(), package.constraints, request.language)
    issues = validate_output(normalized, request, package.plan, package.constraints)
    _emit(
        {
            "ok": True,
            "text": normalized,
            "hard": any(i.hard for i in issues),
            "issues": [_issue(i) for i in issues],
        }
    )


def cmd_selfcheck(args) -> None:
    try:
        import humanizer_framework  # noqa: F401
        from humanizer_framework.providers import ZaiAnthropicProvider, default_provider
    except Exception as exc:
        _die(f"humanizer_framework is not importable: {exc}")

    legs = [
        {"provider": type(p).__name__, "model": getattr(p, "model", None)}
        for p in default_provider().providers
    ]
    try:
        ZaiAnthropicProvider()._resolve_key()
        key = "resolved"
    except Exception as exc:
        key = f"missing ({exc})"
    voice_md = Path(args.voice_md)
    _emit(
        {
            "ok": True,
            "legs": legs,
            "zai_key": key,
            "voice_md": str(voice_md),
            "voice_md_found": voice_md.is_file(),
        }
    )


def main() -> None:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except AttributeError:
            pass

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--voice-md", default=str(ROOT / "voice-dna.md"))

    parser = argparse.ArgumentParser(description=__doc__, parents=[common])
    sub = parser.add_subparsers(dest="command", required=True)

    p_write = sub.add_parser("write", parents=[common])
    p_write.add_argument("--goal", required=True)
    p_write.add_argument("--channel", default="hh")
    p_write.add_argument("--type", default="application", choices=MESSAGE_TYPES)
    p_write.add_argument("--language", default="en")
    p_write.add_argument("--profile", default="career-ops")
    p_write.add_argument("--context-file")
    p_write.add_argument("--dialogue-file")
    p_write.add_argument("--rule", action="append", default=[])
    p_write.set_defaults(func=cmd_write)

    p_validate = sub.add_parser("validate", parents=[common])
    p_validate.add_argument("--text")
    p_validate.add_argument("--text-file")
    p_validate.add_argument("--channel", default="hh")
    p_validate.add_argument("--type", default="application", choices=MESSAGE_TYPES)
    p_validate.add_argument("--language", default="en")
    p_validate.add_argument("--profile", default="career-ops")
    p_validate.add_argument("--dialogue-file")
    p_validate.set_defaults(func=cmd_validate)

    p_check = sub.add_parser("selfcheck", parents=[common])
    p_check.set_defaults(func=cmd_selfcheck)

    args = parser.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception as exc:
        _die(f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
