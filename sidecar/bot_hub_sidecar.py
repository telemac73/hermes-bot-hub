"""Bot Hub sidecar — roster data and a few actions for the Hermes WebUI "Bots" extension.

Serves, on 127.0.0.1 only, what the WebUI API does not expose:

* each profile's identity (display name, role, avatar seed) from profile.yaml / SOUL.md
* its routines (cron jobs, from every profile's store, attributed to the bot they run as)
* the shared gateway's state (running, connected platforms)
* live activity per profile and pending gateway approvals, from the pixel-office
  plugin's /state, when that plugin is running

Actions (POST, JSON):

* /approval          answer a pending gateway approval: "once" or "deny" only, relayed to
                     pixel-office's signed /approval endpoint (the same path as the ESP32 screen)
* /routine           pause / resume / run a routine          (hermes cron …)
* /routine/create    add a routine to a bot                   (hermes -p <bot> cron create …)
* /bot/update        name, role, description, face, persona (profile.yaml / SOUL.md, with backups)
                     and model (through the WebUI's own validated /api/model/set, aimed at the bot)
* /bot/archive       first half of deleting a bot (never the main profile): typed confirmation, then
                     an archive (hermes profile export → ~/.hermes/profile-exports/); the browser then
                     deletes through the WebUI's own /api/profile/delete
* /bot/delete        archive + delete server-side (only while the WebUI has no password)
* /speak             text → MP3 in the bot's voice (only when voice is configured, see below)

Any action may be posted with "_async": true: the reply is a job id at once (202) and the result is
read from GET /job?id=… (GET /job/audio?id=… for /speak). The WebUI proxy cuts a call after 10 s.

GET /config tells the extension what this installation offers: voice (and its voices), and whether
pixel-office (live status, approvals), bot-forge (new bot in one sentence) and the bothub-team plugin
are there. Installation-specific settings live in ~/.hermes/bot-hub/config.json (see DEFAULT_SETTINGS).

The WebUI reaches it through its extension sidecar proxy:
    /api/extensions/bot-hub/sidecar/<path>

Stdlib + PyYAML.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import yaml
except ImportError:  # pragma: no cover - the Hermes venv ships PyYAML
    yaml = None

HOST = "127.0.0.1"
PORT = int(os.environ.get("BOT_HUB_PORT", "17790"))
HERMES_HOME = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).expanduser()
HERMES_BIN = (os.environ.get("HERMES_BIN") or shutil.which("hermes")
              or str(Path.home() / ".local" / "bin" / "hermes"))
CACHE_SECONDS = 4.0
MAX_BODY = 16 * 1024

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
JOB_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
RID_RE = re.compile(r"^[0-9a-f]{32}$")
SCHEDULE_RE = re.compile(r"^[\w\s*/,:.+-]{1,80}$")

_cache_lock = threading.Lock()
_cache: Dict[str, Any] = {"ts": 0.0, "payload": None}

VERSION = "2.1.0"


# ── messages: English, or French when the request says so ("_lang": "fr" / ?lang=fr) ──

_lang_local = threading.local()


def _(en: str, **values: Any) -> str:
    text = MESSAGES_FR.get(en, en) if getattr(_lang_local, "lang", "en") == "fr" else en
    return text.format(**values) if values else text


def _set_lang(value: Any) -> None:
    _lang_local.lang = "fr" if str(value or "").lower().startswith("fr") else "en"


MESSAGES_FR = {
    "hermes did not answer in time": "hermes n'a pas répondu à temps",
    "hermes command not found": "commande hermes introuvable",
    "hermes failed ({code})": "hermes a échoué ({code})",
    "invalid request (choices: once, deny)": "demande invalide (choix possibles : once, deny)",
    "pixel-office has no screen token": "pixel-office n'a pas de jeton d'écran",
    "this request is no longer pending": "cette demande n'est plus en attente",
    "pixel-office refused ({code})": "pixel-office a refusé ({code})",
    "pixel-office unreachable": "pixel-office injoignable",
    "unknown action": "action inconnue",
    "unknown routine": "routine inconnue",
    "unknown bot": "bot inconnu",
    "invalid schedule (e.g. \"0 8 * * *\" or \"every 2h\")": "horaire invalide (ex. « 0 8 * * * » ou « every 2h »)",
    "instruction missing or too long": "instruction manquante ou trop longue",
    "invalid destination for this bot": "destination invalide pour ce bot",
    "text too long (max {limit} characters)": "texte trop long (max {limit} caractères)",
    "model refused: {detail}": "modèle refusé : {detail}",
    "WebUI unreachable to change the model": "WebUI injoignable pour changer le modèle",
    "PyYAML missing for the Bot Hub service": "PyYAML manquant pour le service Bot Hub",
    "the name cannot be empty": "le nom ne peut pas être vide",
    "voice is off (voice.enabled in Bot Hub's config.json)": "voix désactivée (voice.enabled dans config.json de Bot Hub)",
    "unknown voice": "voix inconnue",
    "invalid \"hidden\" value": "valeur « masqué » invalide",
    "persona too long (max 64 KB)": "personnalité trop longue (max 64 Ko)",
    "the persona cannot be empty": "la personnalité ne peut pas être vide",
    "invalid avatar": "avatar invalide",
    "invalid colour (format #rrggbb)": "couleur invalide (format #rrggbb)",
    "unknown eyes": "yeux inconnus",
    "unknown mouth": "bouche inconnue",
    "the main profile cannot be hidden": "le profil principal ne peut pas être masqué",
    "nothing to change": "rien à changer",
    "empty text": "texte vide",
    "text too long for one piece (max {n} characters)": "texte trop long pour un morceau (max {n} caractères)",
    "speech synthesis took too long": "la synthèse vocale a pris trop de temps",
    "speech command not found: {err}": "commande de synthèse introuvable : {err}",
    "speech synthesis failed: ": "synthèse vocale impossible : ",
    "the main profile cannot be deleted": "le profil principal ne peut pas être supprimé",
    "wrong confirmation: type the bot's name": "confirmation incorrecte : tape le nom du bot",
    "backup failed: deletion cancelled": "sauvegarde impossible : suppression annulée",
    "deletion refused: {detail} (backup: {archive})": "suppression refusée : {detail} (sauvegarde : {archive})",
    "WebUI unreachable, bot not deleted (backup: {archive})": "WebUI injoignable, bot non supprimé (sauvegarde : {archive})",
    "unknown or expired job": "tâche inconnue ou expirée",
    "audio not ready yet": "audio pas encore prêt",
    "JSON expected": "JSON attendu",
    "invalid request body": "corps de requête invalide",
    "invalid JSON": "JSON invalide",
    "model": "modèle",
    "name": "nom",
    "role": "rôle",
    "description": "description",
    "face": "visage",
    "hidden": "masqué",
    "persona": "personnalité",
    "voice": "voix",
    "shown": "affiché",
}


# ── settings (optional ~/.hermes/bot-hub/config.json) ───────────────────────
# Everything specific to one installation lives here, never in the code. Without the file Bot Hub
# runs with voice off. Re-read whenever the file changes, so no restart is needed.

CONFIG_PATH = Path(os.environ.get("BOT_HUB_CONFIG") or (HERMES_HOME / "bot-hub" / "config.json")).expanduser()
DEFAULT_SETTINGS: Dict[str, Any] = {
    # interface language: "" follows the WebUI's language; "en" or "fr" forces it
    "language": "",
    "voice": {
        "enabled": False,
        # Hermes ``tts.providers.<provider>`` entry Bot Hub writes into a bot's config when you pick its voice
        "provider": "bothub",
        # text-to-speech command, as an argument list; {input} is a UTF-8 text file, {output} the MP3 to write
        # e.g. ["python3", "/opt/tts/tts.py", "-f", "{input}", "-o", "{output}", "-v", "{voice}"]
        "command": [],
        "voices": [],          # [["Charon", "informative"], ["Puck", "upbeat"], ...] — name, short description
        "default_voice": "",   # first of "voices" when empty
        "timeout": 150,        # seconds for one chunk
        "max_chars": 1200,     # longest chunk the browser sends at once
    },
}
_settings_lock = threading.Lock()
_settings: Dict[str, Any] = {"mtime": None, "value": None}


def _merged(defaults: Dict[str, Any], given: Any) -> Dict[str, Any]:
    out = dict(defaults)
    if isinstance(given, dict):
        for key, value in given.items():
            if key in defaults and isinstance(defaults[key], dict):
                out[key] = _merged(defaults[key], value)
            elif key in defaults and (value is None or type(value) is not type(defaults[key])):
                continue  # wrong type: keep the default rather than half-apply it
            else:
                out[key] = value
    return out


def settings() -> Dict[str, Any]:
    try:
        mtime = CONFIG_PATH.stat().st_mtime
    except OSError:
        mtime = None
    with _settings_lock:
        if _settings["value"] is None or _settings["mtime"] != mtime:
            value = _merged(DEFAULT_SETTINGS, _read_json(CONFIG_PATH) if mtime is not None else None)
            voice = value["voice"]
            voice["voices"] = [[str(v[0]), str(v[1]) if len(v) > 1 else ""] for v in voice["voices"]
                               if isinstance(v, (list, tuple)) and v and str(v[0]).strip()]
            voice["command"] = [str(a) for a in voice["command"]]
            names = [v[0] for v in voice["voices"]]
            if voice["default_voice"] not in names:
                voice["default_voice"] = names[0] if names else ""
            voice["enabled"] = bool(voice["enabled"] and voice["command"] and names)
            _settings.update(mtime=mtime, value=value)
        return _settings["value"]


def _voice_settings() -> Dict[str, Any]:
    return settings()["voice"]


# ── reading ─────────────────────────────────────────────────────────────────

def _read_yaml(path: Path) -> Dict[str, Any]:
    if yaml is None or not path.is_file():
        return {}
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _read_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _profile_dirs() -> List[Tuple[str, Path]]:
    dirs = [("default", HERMES_HOME)]
    root = HERMES_HOME / "profiles"
    if root.is_dir():
        for p in sorted(root.iterdir()):
            if p.is_dir() and not p.name.startswith(".") and (p / "config.yaml").exists():
                dirs.append((p.name, p))
    return dirs


def _profile_names() -> List[str]:
    return [n for n, _ in _profile_dirs()]


def _soul_summary(home: Path) -> Dict[str, str]:
    """First H1 of SOUL.md ("Ada — Research assistant") split into name/role."""
    out = {"title": "", "role": ""}
    try:
        with (home / "SOUL.md").open(encoding="utf-8") as fh:
            for _ in range(40):
                line = fh.readline()
                if not line:
                    break
                if line.startswith("# "):
                    title = line[2:].strip()
                    out["title"] = title
                    parts = re.split(r"\s+[—–-]\s+", title, maxsplit=1)
                    if len(parts) == 2:
                        out["role"] = parts[1].strip()
                    break
    except OSError:
        pass
    return out


def _plugin_entry(cfg: Dict[str, Any], plugin: str) -> Dict[str, Any]:
    plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
    for node in ((plugins.get("entries") or {}).get(plugin), plugins.get(plugin)):
        if isinstance(node, dict):
            return node
    return {}


FACE_EYES = ("round", "happy", "sleepy", "wink", "dots", "surprised", "angry", "sad", "star", "heart")
FACE_MOUTHS = ("smile", "grin", "mini", "neutral", "o", "sad", "tongue", "smirk", "cat")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _avatar(name: str, meta: Dict[str, Any]) -> Dict[str, str]:
    """Face = desktop-compatible ``blobatar:<seed>:<shape>`` plus Bot Hub's own colour / eyes / mouth."""
    m = re.match(r"^blobatar:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$", str(meta.get("shape") or ""))
    face = {"seed": m.group(1), "style": m.group(2)} if m else {"seed": name, "style": ""}
    extra = meta.get("bothub_face") if isinstance(meta.get("bothub_face"), dict) else {}
    face["color"] = str(extra.get("color") or "") if COLOR_RE.match(str(extra.get("color") or "")) else ""
    face["eyes"] = str(extra.get("eyes") or "") if extra.get("eyes") in FACE_EYES else ""
    face["mouth"] = str(extra.get("mouth") or "") if extra.get("mouth") in FACE_MOUTHS else ""
    return face


def _routines_by_bot(names: List[str]) -> Dict[str, List[Dict[str, Any]]]:
    """Every job of every profile's store, attributed to the profile it runs as."""
    out: Dict[str, List[Dict[str, Any]]] = {n: [] for n in names}
    for store, home in _profile_dirs():
        data = _read_json(home / "cron" / "jobs.json")
        jobs = data.get("jobs") if isinstance(data, dict) else data
        for job in jobs if isinstance(jobs, list) else []:
            if not isinstance(job, dict) or not job.get("id"):
                continue
            bot = job.get("profile") or job.get("owner_profile") or store
            if bot not in out:
                bot = store
            sched = job.get("schedule")
            out[bot].append({
                "id": job.get("id"),
                "store": store,
                "name": job.get("name") or "(sans nom)",
                "enabled": job.get("enabled", True) is not False,
                "state": job.get("state"),
                "paused": job.get("state") == "paused" or bool(job.get("paused_at")),
                "schedule": job.get("schedule_display") or (sched.get("display") if isinstance(sched, dict) else sched),
                "deliver": job.get("deliver"),
                "next_run_at": job.get("next_run_at"),
                "last_run_at": job.get("last_run_at"),
                "last_status": job.get("last_status"),
                "last_error": (str(job.get("last_error"))[:200] if job.get("last_error") else None),
                "prompt": (str(job.get("prompt") or "")[:280]),
            })
    return out


def _channels(home: Path) -> List[str]:
    """Messaging channels this profile can deliver to (key names only; values are never read out)."""
    found = []
    try:
        keys = {line.split("=", 1)[0].strip() for line in (home / ".env").read_text(encoding="utf-8").splitlines()
                if "=" in line and not line.lstrip().startswith("#") and line.split("=", 1)[1].strip()}
    except OSError:
        keys = set()
    if "TELEGRAM_BOT_TOKEN" in keys:
        found.append("telegram")
    if "DISCORD_BOT_TOKEN" in keys:
        found.append("discord")
    return found


def _voice(cfg: Dict[str, Any]) -> Optional[Dict[str, str]]:
    """The bot's spoken voice: ``tts.provider`` and that provider's voice (custom command or built-in)."""
    tts = cfg.get("tts") if isinstance(cfg.get("tts"), dict) else {}
    provider = str(tts.get("provider") or "")
    if not provider:
        return None
    custom = (tts.get("providers") or {}).get(provider) if isinstance(tts.get("providers"), dict) else None
    section = custom if isinstance(custom, dict) else (tts.get(provider) if isinstance(tts.get(provider), dict) else {})
    voice = section.get("voice") or section.get("voice_id") or ""
    return {"provider": provider, "voice": str(voice)}


def _pid_alive(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def _gateway() -> Dict[str, Any]:
    st = _read_json(HERMES_HOME / "gateway_state.json")
    if not isinstance(st, dict):
        return {"running": False, "platforms": {}, "served_profiles": []}
    platforms = {name: info.get("state") for name, info in (st.get("platforms") or {}).items()
                 if isinstance(info, dict)}
    return {
        "running": st.get("gateway_state") == "running" and _pid_alive(st.get("pid")),
        "platforms": platforms,
        "served_profiles": st.get("served_profiles") or [],
        "active_agents": st.get("active_agents") or 0,
    }


def _pixel_port(cfg: Dict[str, Any]) -> int:
    port = _plugin_entry(cfg, "pixel-office").get("port")
    return port if isinstance(port, int) else 8113


def _live_agents(port: int) -> Optional[List[Dict[str, Any]]]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/state", timeout=1.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None
    agents = data.get("agents") if isinstance(data, dict) else None
    return agents if isinstance(agents, list) else None


def _live_for(agents: Optional[List[Dict[str, Any]]], profile: str) -> Optional[Dict[str, Any]]:
    if agents is None:
        return None
    mine = [a for a in agents if (a.get("profile") or "default") == profile]
    mains = [a for a in mine if a.get("kind") != "subagent"]
    subs = [a for a in mine if a.get("kind") == "subagent" and a.get("status") in ("working", "thinking", "waiting")]
    rank = {"waiting": 4, "working": 3, "thinking": 2, "idle": 1}
    best = max(mains, key=lambda a: (rank.get(a.get("status"), 0), a.get("updated_at") or 0), default=None)
    if best is None and not subs:
        return {"status": "idle", "subagents": 0}
    if best is None:
        best = subs[0]
    # a Hermes Kanban task one of its sessions is running (pixel-office tags kanban workers)
    task = next((a.get("kanban") for a in sorted(mine, key=lambda a: a.get("updated_at") or 0, reverse=True)
                 if isinstance(a.get("kanban"), dict) and a.get("status") in ("working", "thinking", "waiting")), None)
    return {
        "status": best.get("status") or "idle",
        "tool": best.get("tool") or "",
        "detail": best.get("detail") or "",
        "title": best.get("title") or "",
        "platform": best.get("platform") or "",
        "updated_at": best.get("updated_at"),
        "subagents": len(subs),
        "waiting": any(a.get("status") == "waiting" for a in mine),
        "kanban": {"id": str(task.get("id") or ""), "title": str(task.get("title") or "")} if task else None,
    }


def _approvals(agents: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    out = []
    for a in agents or []:
        if a.get("status") != "waiting":
            continue
        out.append({
            "request_id": a.get("request") or "",
            "answerable": bool(RID_RE.match(str(a.get("request") or ""))),
            "profile": a.get("profile") or "default",
            "command": a.get("command") or a.get("detail") or "",
            "title": a.get("title") or "",
            "platform": a.get("platform") or "",
            "since": a.get("updated_at"),
            "wait": a.get("wait") or 0,
        })
    return out


def build_payload() -> Dict[str, Any]:
    root_cfg = _read_yaml(HERMES_HOME / "config.yaml")
    po_names = {str(k): str(v) for k, v in (_plugin_entry(root_cfg, "pixel-office").get("names") or {}).items()}
    agents = _live_agents(_pixel_port(root_cfg))
    names = _profile_names()
    routines = _routines_by_bot(names)
    bots = []
    for name, home in _profile_dirs():
        meta = _read_yaml(home / "profile.yaml")
        ui_meta = meta.get("ui_meta") if isinstance(meta.get("ui_meta"), dict) else {}
        ui = ui_meta.get("hermes-bots") if isinstance(ui_meta.get("hermes-bots"), dict) else {}
        soul = _soul_summary(home)
        cfg = root_cfg if name == "default" else _read_yaml(home / "config.yaml")
        model = cfg.get("model") if isinstance(cfg.get("model"), dict) else {}
        display = (meta.get("display_name") or ui.get("title") or po_names.get(name)
                   or (name.capitalize() if name != "default" else "Hermes"))
        bots.append({
            "name": name,
            "display_name": str(display),
            "role": soul["role"] or str(ui.get("role") or ""),
            "soul_title": soul["title"],
            "description": str(meta.get("description") or ui.get("description") or ""),
            "avatar": _avatar(name, ui),
            "hidden": bool(ui.get("hidden")),
            "channels": _channels(home),
            "voice": _voice(cfg),
            "model": {"default": str(model.get("default") or ""), "provider": str(model.get("provider") or "")},
            "routines": routines.get(name, []),
            "live": _live_for(agents, name),
        })
    return {
        "bots": bots,
        "gateway": _gateway(),
        "approvals": _approvals(agents),
        "live_source": "pixel-office" if agents is not None else None,
        "ts": time.time(),
    }


def _plugin_enabled(cfg: Dict[str, Any], plugin: str) -> bool:
    plugins = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
    enabled = plugins.get("enabled") if isinstance(plugins.get("enabled"), list) else []
    return plugin in enabled and (HERMES_HOME / "plugins" / plugin).is_dir()


def client_config() -> Dict[str, Any]:
    """What the extension may offer on this installation (GET /config)."""
    root_cfg = _read_yaml(HERMES_HOME / "config.yaml")
    voice = _voice_settings()
    language = settings()["language"]
    return {
        "version": VERSION,
        "language": language if language in ("en", "fr") else "",
        "voice": {"enabled": voice["enabled"], "voices": voice["voices"] if voice["enabled"] else [],
                  "default": voice["default_voice"] if voice["enabled"] else ""},
        "features": {
            # live status and the approvals inbox come from pixel-office's /state
            "pixel_office": _plugin_enabled(root_cfg, "pixel-office"),
            # "new bot in one sentence" asks the main profile to use bot-forge's create_agent
            "bot_forge": _plugin_enabled(root_cfg, "bot-forge"),
            # bot-to-bot questions (hermes-plugin/bothub-team)
            "team": (HERMES_HOME / "plugins" / "bothub-team").is_dir(),
        },
    }


def cached_payload(force: bool = False) -> Dict[str, Any]:
    with _cache_lock:
        now = time.time()
        if force or _cache["payload"] is None or now - _cache["ts"] > CACHE_SECONDS:
            _cache["payload"] = build_payload()
            _cache["ts"] = now
        return _cache["payload"]


def _invalidate() -> None:
    with _cache_lock:
        _cache["payload"] = None


# ── actions ─────────────────────────────────────────────────────────────────

class ActionError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def _hermes(*args: str, timeout: int = 90) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
    env["HERMES_HOME"] = str(HERMES_HOME)
    try:
        p = subprocess.run([HERMES_BIN, *args], capture_output=True, text=True, stdin=subprocess.DEVNULL,
                           timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise ActionError(_("hermes did not answer in time"), 504)
    except FileNotFoundError:
        raise ActionError(_("hermes command not found"), 500)
    out = (p.stdout or "").strip()
    if p.returncode != 0:
        raise ActionError(((p.stderr or "") + "\n" + out).strip()[-600:] or _("hermes failed ({code})", code=p.returncode), 502)
    return out[-600:]


def answer_approval(body: Dict[str, Any]) -> Dict[str, Any]:
    rid, choice = str(body.get("request_id") or ""), body.get("choice")
    if not RID_RE.match(rid) or choice not in ("once", "deny"):
        raise ActionError(_("invalid request (choices: once, deny)"))
    try:
        token = (HERMES_HOME / "pixel-office" / "screen_token").read_text(encoding="ascii").strip()
    except OSError:
        raise ActionError(_("pixel-office has no screen token"), 503)
    ts = str(int(time.time()))
    sig = hmac.new(token.encode("ascii"), f"approval|{rid}|{choice}|{ts}".encode("utf-8"), hashlib.sha256).hexdigest()
    port = _pixel_port(_read_yaml(HERMES_HOME / "config.yaml"))
    req = urllib.request.Request(
        f"http://127.0.0.1:{port}/approval",
        data=json.dumps({"request_id": rid, "choice": choice}).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Pixel-Time": ts, "X-Pixel-Sig": sig},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            reply = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise ActionError(_("this request is no longer pending"), 404)
        raise ActionError(_("pixel-office refused ({code})", code=exc.code), 502)
    except Exception:
        raise ActionError(_("pixel-office unreachable"), 503)
    _invalidate()
    return {"ok": bool(reply.get("ok")), "choice": choice}


def routine_action(body: Dict[str, Any]) -> Dict[str, Any]:
    action, store, job = body.get("action"), str(body.get("store") or ""), str(body.get("id") or "")
    if action not in ("pause", "resume", "run"):
        raise ActionError(_("unknown action"))
    if store not in _profile_names() or not JOB_RE.match(job):
        raise ActionError(_("unknown routine"), 404)
    out = _hermes("-p", store, "cron", action, job)
    _invalidate()
    return {"ok": True, "action": action, "output": out}


def routine_create(body: Dict[str, Any]) -> Dict[str, Any]:
    bot = str(body.get("bot") or "")
    name = str(body.get("name") or "").strip()[:80]
    schedule = str(body.get("schedule") or "").strip()
    prompt = str(body.get("prompt") or "").strip()
    deliver = str(body.get("deliver") or "local").strip()
    if not NAME_RE.match(bot) or bot not in _profile_names():
        raise ActionError(_("unknown bot"), 404)
    if not SCHEDULE_RE.match(schedule):
        raise ActionError(_("invalid schedule (e.g. \"0 8 * * *\" or \"every 2h\")"))
    if not 3 <= len(prompt) <= 4000:
        raise ActionError(_("instruction missing or too long"))
    home = HERMES_HOME if bot == "default" else HERMES_HOME / "profiles" / bot
    if deliver not in ["local", f"bot-chat:{bot}", *_channels(home)]:
        raise ActionError(_("invalid destination for this bot"))
    args = ["-p", bot, "cron", "create", schedule, prompt, "--deliver", deliver]
    if name:
        args += ["--name", name]
    out = _hermes(*args)
    _invalidate()
    return {"ok": True, "output": out}


# ── editing a bot: name, role, description, face, persona, model ────────────

BLOB_KINDS = ("round", "organic", "boxy", "capsule", "nub", "cloud", "droplet", "hexagon", "sun", "triangle")
SEED_RE = re.compile(r"^[A-Za-z0-9_-]{1,40}$")
MAX_SOUL_BYTES = 64_000
WEBUI = os.environ.get("BOT_HUB_WEBUI", "http://127.0.0.1:8787")


def _bot_home(bot: str) -> Path:
    if not NAME_RE.match(bot or "") or bot not in _profile_names():
        raise ActionError(_("unknown bot"), 404)
    return HERMES_HOME if bot == "default" else HERMES_HOME / "profiles" / bot


def _backup(home: Path, path: Path) -> str:
    if not path.exists():
        return ""
    dest = home / "backups" / "bot-hub" / f"{path.name}.{time.strftime('%Y%m%d-%H%M%S')}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, dest)
    return str(dest)


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.bothub.tmp")
    tmp.write_text(text, encoding="utf-8")
    if path.exists():
        shutil.copymode(path, tmp)
    os.replace(tmp, path)


def _clean_line(value: Any, limit: int) -> Optional[str]:
    if value is None:
        return None
    text = re.sub(r"\s+", " ", str(value)).strip()
    if len(text) > limit:
        raise ActionError(_("text too long (max {limit} characters)", limit=limit))
    return text


def _rewrite_identity(soul: str, old: str, new: str, role: Optional[str]) -> str:
    """Update the '# Name — Role' heading and the name in the identity lines; keep the rest as written."""
    lines = soul.split("\n")
    for i, line in enumerate(lines[:6]):
        if line.startswith("# "):
            parts = re.split(r"\s+[—–-]\s+", line[2:].strip(), maxsplit=1)
            current_role = parts[1].strip() if len(parts) == 2 else ""
            final_role = current_role if role is None else role
            lines[i] = f"# {new} — {final_role}" if final_role else f"# {new}"
            break
    text = "\n".join(lines)
    if old and new and old != new:
        text = text.replace(f"**{old}**", f"**{new}**")
        text = re.sub(rf"(introduce yourself as) {re.escape(old)}\b", rf"\1 {new}", text)
        text = re.sub(rf"(Présente-toi (?:toujours )?comme) {re.escape(old)}\b", rf"\1 {new}", text)
    return text


def _set_model(bot: str, model_id: str, provider: str) -> Dict[str, Any]:
    """Same validated path as the WebUI's model picker, aimed at this bot's profile via its cookie."""
    req = urllib.request.Request(
        f"{WEBUI}/api/model/set",
        data=json.dumps({"scope": "main", "model": model_id, "provider": provider or "auto"}).encode("utf-8"),
        headers={"Content-Type": "application/json", "Cookie": f"hermes_profile={bot}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            reply = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8") or "{}").get("error")
        except Exception:
            detail = None
        raise ActionError(_("model refused: {detail}", detail=detail or exc.code), 400)
    except Exception:
        raise ActionError(_("WebUI unreachable to change the model"), 503)
    if not reply.get("ok"):
        raise ActionError(_("model refused: {detail}", detail=reply.get("error") or reply), 400)
    return reply


def bot_soul(bot: str) -> Dict[str, Any]:
    home = _bot_home(bot)
    try:
        return {"bot": bot, "soul": (home / "SOUL.md").read_text(encoding="utf-8")}
    except OSError:
        return {"bot": bot, "soul": ""}


def bot_update(body: Dict[str, Any]) -> Dict[str, Any]:
    if yaml is None:
        raise ActionError(_("PyYAML missing for the Bot Hub service"), 500)
    bot = str(body.get("bot") or "")
    home = _bot_home(bot)
    name = _clean_line(body.get("display_name"), 40)
    role = _clean_line(body.get("role"), 80)
    description = _clean_line(body.get("description"), 400)
    soul_text = body.get("soul")
    avatar = body.get("avatar") if isinstance(body.get("avatar"), dict) else None
    model = body.get("model") if isinstance(body.get("model"), dict) else None
    voice = body.get("voice")
    hidden = body.get("hidden")
    if name is not None and not name:
        raise ActionError(_("the name cannot be empty"))
    if voice is not None and not _voice_settings()["enabled"]:
        raise ActionError(_("voice is off (voice.enabled in Bot Hub's config.json)"))
    if voice is not None and voice not in _voice_names():
        raise ActionError(_("unknown voice"))
    if hidden is not None and not isinstance(hidden, bool):
        raise ActionError(_("invalid \"hidden\" value"))
    if soul_text is not None:
        soul_text = str(soul_text)
        if len(soul_text.encode("utf-8")) > MAX_SOUL_BYTES:
            raise ActionError(_("persona too long (max 64 KB)"))
        if not soul_text.strip():
            raise ActionError(_("the persona cannot be empty"))
    if avatar is not None:
        if avatar.get("style") not in BLOB_KINDS or not SEED_RE.match(str(avatar.get("seed") or "")):
            raise ActionError(_("invalid avatar"))
        if avatar.get("color") and not COLOR_RE.match(str(avatar["color"])):
            raise ActionError(_("invalid colour (format #rrggbb)"))
        if avatar.get("eyes") and avatar["eyes"] not in FACE_EYES:
            raise ActionError(_("unknown eyes"))
        if avatar.get("mouth") and avatar["mouth"] not in FACE_MOUTHS:
            raise ActionError(_("unknown mouth"))

    changed, backups = [], {}

    # 1. model first: if the provider refuses it, nothing else has been touched
    if model and model.get("id"):
        model_id = str(model.get("id"))[:200]
        provider = str(model.get("provider") or "")[:80]
        _set_model(bot, model_id, provider)
        changed.append("model")

    # 2. profile.yaml: roster identity (same layout Hermes and the desktop app use)
    meta_path = home / "profile.yaml"
    meta = _read_yaml(meta_path)
    ui_meta = meta.get("ui_meta") if isinstance(meta.get("ui_meta"), dict) else {}
    ui = ui_meta.get("hermes-bots") if isinstance(ui_meta.get("hermes-bots"), dict) else {}
    cfg = _read_yaml(HERMES_HOME / "config.yaml")
    po_names = _plugin_entry(cfg, "pixel-office").get("names") or {}
    old_name = str(meta.get("display_name") or ui.get("title") or po_names.get(bot)
                   or (bot.capitalize() if bot != "default" else "Hermes"))
    old_role = _soul_summary(home)["role"] or str(ui.get("role") or "")
    meta_changed = False
    if name is not None and name != old_name:
        meta["display_name"] = name
        ui["title"] = name
        previous = [p for p in (meta.get("previous_names") or []) if isinstance(p, str)]
        if old_name and old_name not in previous:
            previous.append(old_name)
        meta["previous_names"] = previous[-10:]
        meta_changed = True
        changed.append("name")
    if role is not None and role != old_role:
        ui["role"] = role
        meta_changed = True
        changed.append("role")
    if description is not None and description != str(meta.get("description") or ""):
        meta["description"] = description
        meta["description_auto"] = False
        ui["description"] = description
        meta_changed = True
        changed.append("description")
    if avatar is not None:
        shape = f"blobatar:{avatar['seed']}:{avatar['style']}"
        extra = {k: str(avatar.get(k) or "") for k in ("color", "eyes", "mouth") if avatar.get(k)}
        old_extra = ui.get("bothub_face") if isinstance(ui.get("bothub_face"), dict) else {}
        if shape != ui.get("shape") or extra != old_extra:
            ui["shape"] = shape
            ui["imageKind"] = "shape"
            if extra:
                ui["bothub_face"] = extra
            else:
                ui.pop("bothub_face", None)
            meta_changed = True
            changed.append("face")
    if hidden is not None and hidden != bool(ui.get("hidden")):
        if hidden and bot == "default":
            raise ActionError(_("the main profile cannot be hidden"))
        if hidden:
            ui["hidden"] = True  # same key bot-forge's hide_agent uses
        else:
            ui.pop("hidden", None)
        meta_changed = True
        changed.append("hidden" if hidden else "shown")
    if meta_changed:
        ui_meta["hermes-bots"] = ui
        meta["ui_meta"] = ui_meta
        revisions = meta.get("_ui_meta_revisions") if isinstance(meta.get("_ui_meta_revisions"), dict) else {}
        revisions["hermes-bots"] = int(revisions.get("hermes-bots", 0) or 0) + 1
        meta["_ui_meta_revisions"] = revisions
        backups["profile.yaml"] = _backup(home, meta_path)
        _atomic_write(meta_path, yaml.safe_dump(meta, sort_keys=False, allow_unicode=True, width=1000))

    # 3. persona: an explicit SOUL.md wins; otherwise keep its heading and identity lines in step
    soul_path = home / "SOUL.md"
    new_name = name if name is not None else old_name
    if soul_text is not None:
        current = soul_path.read_text(encoding="utf-8") if soul_path.exists() else ""
        if soul_text != current:
            backups["SOUL.md"] = _backup(home, soul_path)
            _atomic_write(soul_path, soul_text if soul_text.endswith("\n") else soul_text + "\n")
            changed.append("persona")
    elif bot != "default" and soul_path.exists() and ("name" in changed or "role" in changed):
        current = soul_path.read_text(encoding="utf-8")
        updated = _rewrite_identity(current, old_name, new_name, role if "role" in changed else None)
        if updated != current:
            backups["SOUL.md"] = _backup(home, soul_path)
            _atomic_write(soul_path, updated)

    # 4. memory keeps the bot's own name straight after a rename
    if "name" in changed:
        mem = home / "memories" / "MEMORY.md"
        if mem.exists():
            text = mem.read_text(encoding="utf-8")
            updated = text.replace(f"My name is {old_name}.", f"My name is {new_name}.")
            updated = updated.replace(f"I always introduce myself as {old_name}", f"I always introduce myself as {new_name}")
            if updated != text:
                backups["MEMORY.md"] = _backup(home, mem)
                _atomic_write(mem, updated)
        if bot == "default":  # pixel-office labels the main agent from its own config entry
            try:
                _hermes("config", "set", "--force", "plugins.entries.pixel-office.names.default", new_name)
            except ActionError:
                pass

    # 5. spoken voice: Bot Hub's command provider (voice.provider / voice.command), created if this bot lacks it
    if voice is not None:
        provider = _voice_settings()["provider"]
        cfg_bot = _read_yaml(home / "config.yaml")
        current = _voice(cfg_bot) or {}
        if current.get("provider") != provider or current.get("voice") != voice:
            backups["config.yaml"] = _backup(home, home / "config.yaml")
            if current.get("provider") != provider:
                for key, value in (("type", "command"), ("command", _hermes_tts_command()), ("output_format", "mp3"),
                                   ("timeout", str(max(30, _voice_settings()["timeout"] + 30))),
                                   ("voice_compatible", "true")):
                    _hermes("-p", bot, "config", "set", "--force", f"tts.providers.{provider}.{key}", value)
                _hermes("-p", bot, "config", "set", "tts.provider", provider)
            _hermes("-p", bot, "config", "set", "--force", f"tts.providers.{provider}.voice", voice)
            changed.append("voice")

    _invalidate()
    if not changed:
        return {"ok": True, "changed": [], "note": _("nothing to change")}
    return {"ok": True, "changed": [_(c) for c in changed], "backups": {k: v for k, v in backups.items() if v}}


# ── speaking with a bot's voice (WebUI "Listen" button / auto-read) ──────────

SPEAK_CACHE = Path(os.environ.get("BOT_HUB_TTS_CACHE") or "/tmp/bot-hub-tts")
SPEAK_CACHE_KEEP = 60
_speak_lock = threading.Lock()


def _voice_names() -> List[str]:
    return [v[0] for v in _voice_settings()["voices"]]


def _hermes_tts_command() -> str:
    """The configured command as a Hermes command-provider string ({input_path}/{output_path}/{voice})."""
    import shlex
    parts = []
    for arg in _voice_settings()["command"]:
        arg = arg.replace("{input}", "{input_path}").replace("{output}", "{output_path}")
        parts.append(arg if "{" in arg else shlex.quote(arg))
    return " ".join(parts)


def speak(body: Dict[str, Any]) -> bytes:
    """Text → small MP3 (mono, 48 kbit/s when ffmpeg is there, to stay under the WebUI proxy's 512 KB
    cap) in the bot's voice. The caller splits long replies; identical requests come from a small
    on-disk cache."""
    conf = _voice_settings()
    if not conf["enabled"]:
        raise ActionError(_("voice is off (voice.enabled in Bot Hub's config.json)"), 404)
    bot = str(body.get("bot") or "")
    home = _bot_home(bot)
    text = re.sub(r"\s+", " ", str(body.get("text") or "")).strip()
    if not text:
        raise ActionError(_("empty text"))
    if len(text) > conf["max_chars"]:
        raise ActionError(_("text too long for one piece (max {n} characters)", n=conf["max_chars"]))
    voice = body.get("voice")
    if voice is not None and voice not in _voice_names():
        raise ActionError(_("unknown voice"))
    if voice is None:
        current = _voice(_read_yaml(HERMES_HOME / "config.yaml") if bot == "default" else _read_yaml(home / "config.yaml")) or {}
        voice = current.get("voice") if current.get("voice") in _voice_names() else conf["default_voice"]
    key = hashlib.sha256(f"{voice}|{text}".encode("utf-8")).hexdigest()[:32]
    SPEAK_CACHE.mkdir(parents=True, exist_ok=True)
    out = SPEAK_CACHE / f"{key}.mp3"
    if out.is_file() and out.stat().st_size > 0:
        os.utime(out)
        return out.read_bytes()
    with _speak_lock:  # one synthesis at a time (small machines)
        work = SPEAK_CACHE / f".{key}"
        work.mkdir(exist_ok=True)
        try:
            (work / "input.txt").write_text(text, encoding="utf-8")
            env = {k: v for k, v in os.environ.items() if not k.startswith("HERMES_")}
            argv = [a.replace("{input}", str(work / "input.txt")).replace("{output}", str(work / "raw.mp3"))
                    .replace("{voice}", voice) for a in conf["command"]]
            try:
                p = subprocess.run(argv, capture_output=True, text=True, timeout=conf["timeout"], env=env, cwd=str(work))
            except subprocess.TimeoutExpired:
                raise ActionError(_("speech synthesis took too long"), 504)
            except OSError as exc:
                raise ActionError(_("speech command not found: {err}", err=exc), 500)
            raw = work / "raw.mp3"
            if p.returncode != 0 or not raw.is_file():
                raise ActionError(_("speech synthesis failed: ") + ((p.stdout or "") + (p.stderr or "")).strip()[-300:], 502)
            small = work / "small.mp3"
            if shutil.which("ffmpeg"):
                q = subprocess.run(["ffmpeg", "-y", "-nostdin", "-v", "error", "-i", str(raw), "-ac", "1", "-ar", "24000",
                                    "-b:a", "48k", str(small)], capture_output=True, text=True, timeout=60)
                if q.returncode != 0:
                    small.unlink(missing_ok=True)
            os.replace(small if small.is_file() else raw, out)
        finally:
            shutil.rmtree(work, ignore_errors=True)
        cached = sorted(SPEAK_CACHE.glob("*.mp3"), key=lambda f: f.stat().st_mtime, reverse=True)
        for old in cached[SPEAK_CACHE_KEEP:]:
            old.unlink(missing_ok=True)
    return out.read_bytes()


def bot_archive(body: Dict[str, Any]) -> Dict[str, Any]:
    """First half of deleting a bot: never the main profile, only with its name typed back, and a full
    archive of it (hermes profile export) must exist. The delete itself is then done by the browser,
    through the WebUI's own /api/profile/delete — with the user's session, so it keeps working when the
    WebUI has a password, and the WebUI's profile list and active-profile handling stay right."""
    bot = str(body.get("bot") or "")
    if bot == "default":
        raise ActionError(_("the main profile cannot be deleted"), 403)
    home = _bot_home(bot)
    meta = _read_yaml(home / "profile.yaml")
    ui = ((meta.get("ui_meta") or {}).get("hermes-bots") or {}) if isinstance(meta.get("ui_meta"), dict) else {}
    accepted = {bot.lower(), str(meta.get("display_name") or "").lower(), str(ui.get("title") or "").lower()} - {""}
    if str(body.get("confirm") or "").strip().lower() not in accepted:
        raise ActionError(_("wrong confirmation: type the bot's name"))
    exports = HERMES_HOME / "profile-exports"
    exports.mkdir(parents=True, exist_ok=True)
    archive = exports / f"{bot}-avant-suppression-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    _hermes("profile", "export", bot, "-o", str(archive), timeout=600)
    if not archive.is_file() or archive.stat().st_size == 0:
        raise ActionError(_("backup failed: deletion cancelled"), 500)
    return {"ok": True, "bot": bot, "backup": str(archive)}


def bot_delete(body: Dict[str, Any]) -> Dict[str, Any]:
    """Archive + delete in one call (server-side). Only works while the WebUI has no password;
    the extension uses /bot/archive and deletes through the browser instead."""
    bot = str(body.get("bot") or "")
    if bot == "default":
        raise ActionError(_("the main profile cannot be deleted"), 403)
    home = _bot_home(bot)
    meta = _read_yaml(home / "profile.yaml")
    ui = ((meta.get("ui_meta") or {}).get("hermes-bots") or {}) if isinstance(meta.get("ui_meta"), dict) else {}
    accepted = {bot.lower(), str(meta.get("display_name") or "").lower(), str(ui.get("title") or "").lower()} - {""}
    if str(body.get("confirm") or "").strip().lower() not in accepted:
        raise ActionError(_("wrong confirmation: type the bot's name"))
    exports = HERMES_HOME / "profile-exports"
    exports.mkdir(parents=True, exist_ok=True)
    archive = exports / f"{bot}-avant-suppression-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz"
    _hermes("profile", "export", bot, "-o", str(archive), timeout=600)
    if not archive.is_file() or archive.stat().st_size == 0:
        raise ActionError(_("backup failed: deletion cancelled"), 500)
    req = urllib.request.Request(
        f"{WEBUI}/api/profile/delete", data=json.dumps({"name": bot}).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            reply = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode("utf-8") or "{}").get("error")
        except Exception:
            detail = None
        raise ActionError(_("deletion refused: {detail} (backup: {archive})", detail=detail or exc.code, archive=archive), 400)
    except Exception:
        raise ActionError(_("WebUI unreachable, bot not deleted (backup: {archive})", archive=archive), 503)
    _invalidate()
    return {"ok": True, "deleted": bot, "backup": str(archive), "result": reply}


ROUTES = {
    "/approval": answer_approval,
    "/routine": routine_action,
    "/routine/create": routine_create,
    "/bot/update": bot_update,
    "/bot/archive": bot_archive,
    "/bot/delete": bot_delete,
    "/speak": speak,
}


# ── background jobs ─────────────────────────────────────────────────────────
# The WebUI proxy gives a sidecar call 10 s. Anything that may take longer (hermes CLI starts in
# ~3-5 s, exports, speech) is posted with "_async": true: the call returns a job id at once and the
# browser polls GET /job?id=… (and GET /job/audio?id=… for speech) until it is done.

JOB_TTL = 600
_jobs: Dict[str, Dict[str, Any]] = {}
_jobs_lock = threading.Lock()


def _start_job(handler, body: Dict[str, Any]) -> str:
    job_id = hashlib.sha256(f"{time.time()}|{os.getpid()}|{id(body)}".encode()).hexdigest()[:16]
    job = {"state": "running", "started": time.time(), "result": None, "error": None, "status": 200}
    with _jobs_lock:
        for jid in [j for j, v in _jobs.items() if time.time() - v["started"] > JOB_TTL]:
            _jobs.pop(jid, None)
        _jobs[job_id] = job

    lang = getattr(_lang_local, "lang", "en")  # the job thread answers in the caller's language

    def run() -> None:
        _lang_local.lang = lang
        try:
            job["result"] = handler(body)
            job["state"] = "done"
        except ActionError as exc:
            job["error"], job["status"], job["state"] = str(exc), exc.status, "error"
        except Exception as exc:
            job["error"], job["status"], job["state"] = str(exc)[:300], 500, "error"

    threading.Thread(target=run, name=f"bothub-job-{job_id}", daemon=True).start()
    return job_id


def _job(job_id: str) -> Optional[Dict[str, Any]]:
    with _jobs_lock:
        return _jobs.get(job_id)


# ── HTTP ────────────────────────────────────────────────────────────────────

class Handler(BaseHTTPRequestHandler):
    server_version = "BotHub/2.0"

    def _send(self, code: int, body: Dict[str, Any]) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _path(self) -> str:
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    def do_GET(self) -> None:  # noqa: N802
        path = self._path()
        from urllib.parse import parse_qs, urlparse
        _set_lang((parse_qs(urlparse(self.path).query).get("lang") or [""])[0])
        if path == "/health":
            self._send(200, {"ok": True, "version": VERSION})
        elif path == "/config":
            self._send(200, client_config())
        elif path == "/bots":
            try:
                self._send(200, cached_payload(force="fresh=1" in self.path))
            except Exception as exc:  # never crash the server on one bad profile
                self._send(500, {"error": str(exc)})
        elif path == "/bot/soul":
            from urllib.parse import parse_qs, urlparse
            bot = (parse_qs(urlparse(self.path).query).get("bot") or [""])[0]
            try:
                self._send(200, bot_soul(bot))
            except ActionError as exc:
                self._send(exc.status, {"error": str(exc)})
        elif path in ("/job", "/job/audio"):
            from urllib.parse import parse_qs, urlparse
            job = _job((parse_qs(urlparse(self.path).query).get("id") or [""])[0])
            if job is None:
                self._send(404, {"error": _("unknown or expired job")})
            elif path == "/job/audio":
                if job["state"] == "done" and isinstance(job["result"], bytes):
                    self._send_bytes(job["result"], "audio/mpeg")
                else:
                    self._send(409, {"error": job["error"] or _("audio not ready yet")})
            else:
                result = job["result"]
                self._send(200, {"state": job["state"], "error": job["error"], "status": job["status"],
                                 "result": None if isinstance(result, bytes) else result})
        else:
            self._send(404, {"error": "not found"})

    def _send_bytes(self, data: bytes, content_type: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:  # noqa: N802
        handler = ROUTES.get(self._path())
        if handler is None:
            self._send(404, {"error": "not found"})
            return
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            self._send(415, {"error": _("JSON expected")})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self._send(400, {"error": _("invalid request body")})
            return
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError
        except (ValueError, UnicodeDecodeError):
            self._send(400, {"error": _("invalid JSON")})
            return
        try:
            _set_lang(body.pop("_lang", ""))
            if body.pop("_async", False) is True:
                self._send(202, {"ok": True, "job": _start_job(handler, body)})
            elif handler is speak:
                self._send_bytes(speak(body), "audio/mpeg")
            else:
                self._send(200, handler(body))
        except ActionError as exc:
            self._send(exc.status, {"error": str(exc)})
        except Exception as exc:
            self._send(500, {"error": str(exc)[:300]})

    def log_message(self, fmt: str, *args: Any) -> None:
        pass


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    server.serve_forever()


if __name__ == "__main__":
    main()
