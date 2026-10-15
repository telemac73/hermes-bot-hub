"""bothub-team — let a Hermes bot ask a teammate (another profile) one question.

Two tools in the ``bothub_team`` toolset:

* ``list_team``     who is on the team and what each one does
* ``ask_teammate``  send one self-contained question to a teammate and wait for the answer

The loop guard lives here, not in a prompt:

* a bot answering a teammate cannot ask anyone in turn (``BOTHUB_ASK_DEPTH``),
* nobody asks itself or anyone already in the chain (``BOTHUB_ASK_CHAIN``),
* nobody asks the main profile: it delegates to the bots, and they report back through
  their answer.

The teammate runs as its own profile (``hermes -p <name> chat -Q -q …``) with a clean
environment, so it uses its own model, memory and keys, exactly like bot-forge's ask_agent.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

LEAD = "default"
MAX_DEPTH = 1
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
# Process essentials, network/proxy and config locations only — never anything that carries
# the caller's own credentials (same allowlist reasoning as bot-forge's ask_agent).
SAFE_KEYS = (
    "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "TMPDIR",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NODE_EXTRA_CA_CERTS",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
)

LIST_TEAM = {
    "name": "list_team",
    "description": "List your teammates (other Hermes bots on this install): profile name, display name, role, "
                   "what they are good at. Use it before ask_teammate when unsure who handles what.",
    "parameters": {"type": "object", "properties": {}},
}

ASK_TEAMMATE = {
    "name": "ask_teammate",
    "description": (
        "Ask ONE teammate (another bot of the team, by profile name from list_team) a precise, self-contained "
        "question and wait for the answer (can take a few minutes). The teammate does not see your conversation: "
        "include the context, what you need back and the format. Use it only when part of your task clearly "
        "belongs to that teammate's speciality. You cannot ask the main profile (the team lead) — report to it in "
        "your answer — and if you are yourself answering a teammate, you cannot ask anyone."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "teammate profile name, as listed by list_team"},
            "message": {"type": "string", "description": "self-contained question or task"},
        },
        "required": ["name", "message"],
    },
}


def _root() -> Path:
    try:
        from hermes_constants import get_default_hermes_root
        return Path(get_default_hermes_root())
    except Exception:
        return Path.home() / ".hermes"


def _me(root: Path) -> str:
    try:
        from hermes_constants import get_hermes_home
        home = Path(get_hermes_home()).resolve()
    except Exception:
        home = Path(os.environ.get("HERMES_HOME") or root).resolve()
    if home.parent == (root / "profiles").resolve():
        return home.name
    return LEAD


def _load_yaml(path: Path) -> dict:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    try:
        from yaml import safe_load  # declared in plugin.yaml (already in Hermes' env via bot-forge)
    except Exception:
        return {}
    try:
        data = safe_load(text)
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _identity(home: Path, name: str) -> dict:
    meta = _load_yaml(home / "profile.yaml")
    ui_meta = meta.get("ui_meta") if isinstance(meta.get("ui_meta"), dict) else {}
    ui = ui_meta.get("hermes-bots") if isinstance(ui_meta.get("hermes-bots"), dict) else {}
    role = ""
    try:
        first = (home / "SOUL.md").read_text(encoding="utf-8").lstrip().split("\n", 1)[0]
        m = re.match(r"#\s*[^—–\n]+?\s[—–-]\s+(.+)$", first)
        role = m.group(1).strip() if m else ""
    except OSError:
        pass
    return {
        "name": name,
        "display_name": str(meta.get("display_name") or ui.get("title") or (name.capitalize() if name != LEAD else "Hermes")),
        "role": role or str(ui.get("role") or ""),
        "description": str(meta.get("description") or ui.get("description") or ""),
        "hidden": bool(ui.get("hidden")),
    }


def _lead_name(root: Path) -> str:
    """The main profile's display name: profile.yaml, else the name pixel-office shows for it."""
    ident = _identity(root, LEAD)
    if ident["display_name"] != "Hermes":
        return ident["display_name"]
    entries = (_load_yaml(root / "config.yaml").get("plugins") or {}).get("entries")
    office = entries.get("pixel-office") if isinstance(entries, dict) else None
    names = office.get("names") if isinstance(office, dict) else None
    return str(names.get("default") or "Hermes") if isinstance(names, dict) else "Hermes"


def _members(root: Path, exclude: set) -> list:
    out = []
    profiles = root / "profiles"
    for d in sorted(profiles.iterdir()) if profiles.is_dir() else []:
        if not d.is_dir() or d.name.startswith(".") or not (d / "config.yaml").exists() or d.name in exclude:
            continue
        ident = _identity(d, d.name)
        if not ident.pop("hidden"):
            out.append(ident)
    return out


def _settings(ctx) -> dict:
    exclude = ctx.get_config("exclude", default=None) or []
    timeout = ctx.get_config("timeout_seconds", default=None) or 600
    return {"exclude": {str(x) for x in exclude if isinstance(x, str)}, "timeout": max(60, min(int(timeout), 1800))}


def list_team(args: dict, settings: dict, **_) -> str:
    root = _root()
    me = _me(root)
    lead = _identity(root, LEAD)
    lead.pop("hidden", None)
    lead["display_name"] = _lead_name(root)
    team = [m for m in _members(root, settings["exclude"]) if m["name"] != me]
    depth = int(os.environ.get("BOTHUB_ASK_DEPTH") or 0)
    return json.dumps({
        "you": me,
        "lead": lead,
        "teammates": team,
        "can_ask": depth < MAX_DEPTH,
        "note": "ask_teammate: one precise, self-contained question per need; the lead cannot be asked — "
                "report to it in your answer.",
    }, ensure_ascii=False)


def ask_teammate(args: dict, settings: dict, **_) -> str:
    root = _root()
    me = _me(root)
    name = str(args.get("name") or "").strip().lstrip("@").lower()
    message = str(args.get("message") or "").strip()
    depth = int(os.environ.get("BOTHUB_ASK_DEPTH") or 0)
    chain = [c for c in (os.environ.get("BOTHUB_ASK_CHAIN") or "").split(",") if c]

    def refuse(reason: str) -> str:
        return json.dumps({"ok": False, "error": reason}, ensure_ascii=False)

    if not NAME_RE.match(name) or not message:
        return refuse("a teammate name (see list_team) and a question are both required")
    if depth >= MAX_DEPTH:
        asker = chain[-1] if chain else "a teammate"
        return refuse(f"you are already answering a question from {asker}: finish with what you know, "
                      "without asking another teammate (one relay only)")
    if name == me:
        return refuse("you cannot ask yourself")
    if name == LEAD:
        return refuse(f"{_lead_name(root)} leads the team: it is not asked questions — report to it in your answer")
    if name in chain:
        return refuse(f"{name} is already in this chain of questions: no going back and forth")
    members = {m["name"]: m for m in _members(root, settings["exclude"])}
    if name not in members:
        return refuse(f"no teammate named '{name}' (see list_team)")

    mine = _identity(root if me == LEAD else root / "profiles" / me, me)
    if me == LEAD:
        mine["display_name"] = _lead_name(root)
    text = (f"[Question from {mine['display_name']} (@{me}), your teammate. Answer them directly, concisely "
            f"and verifiably; you cannot ask another teammate for this.]\n\n{message}")
    env = {k: os.environ[k] for k in SAFE_KEYS if k in os.environ}
    env["HERMES_HOME"] = str(root)  # -p resolves under this root, independent of the caller's home
    env["BOTHUB_ASK_DEPTH"] = str(depth + 1)
    env["BOTHUB_ASK_CHAIN"] = ",".join(chain + [me])
    hermes = shutil.which("hermes", path=env.get("PATH")) or str(Path.home() / ".local" / "bin" / "hermes")
    try:
        p = subprocess.run([hermes, "-p", name, "chat", "-Q", "--max-turns", "20", "-q", text],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL,
                           timeout=settings["timeout"], env=env)
    except subprocess.TimeoutExpired:
        return refuse(f"{members[name]['display_name']} did not answer within {settings['timeout'] // 60} min")
    except FileNotFoundError:
        return refuse("hermes command not found")
    reply = (p.stdout or "").strip()
    if p.returncode != 0 or not reply:
        return refuse(((p.stderr or "") + "\n" + reply).strip()[-1500:] or "no answer")
    return json.dumps({"ok": True, "name": name, "display_name": members[name]["display_name"],
                       "reply": reply[-6000:]}, ensure_ascii=False)


def register(ctx):
    ctx.register_tool(name="list_team", toolset="bothub_team", schema=LIST_TEAM,
                      handler=lambda args, **kw: list_team(args, _settings(ctx), **kw),
                      emoji="👥", description="List your teammates and what each one does")
    ctx.register_tool(name="ask_teammate", toolset="bothub_team", schema=ASK_TEAMMATE,
                      handler=lambda args, **kw: ask_teammate(args, _settings(ctx), **kw),
                      emoji="💬", description="Ask one teammate a question and wait for the answer")
