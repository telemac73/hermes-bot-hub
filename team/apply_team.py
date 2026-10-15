"""Add (or refresh) a "your team" section in each bot's SOUL.md, so the bots know who does what and
how to use the bothub-team tools (list_team / ask_teammate). Optionally push the main profile's SOUL.

The roster comes from Bot Hub itself (GET /bots): every profile except the main one and the hidden
ones. Each change goes through the sidecar's /bot/update, which backs up every file it touches.

Run on the Hermes machine, with the Bot Hub sidecar running:

    python3 apply_team.py --dry-run                 # show the sections, change nothing
    python3 apply_team.py --lang fr --owner Alex    # write them (French text, "Alex's team")
    python3 apply_team.py --exclude test-bot --lead-soul lead.SOUL.md

Environment: BOT_HUB_URL (default http://127.0.0.1:17790).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.parse
import urllib.request

SIDE = os.environ.get("BOT_HUB_URL", "http://127.0.0.1:17790").rstrip("/")

TEXT = {
    "en": {
        "heading": "## Your team",
        "intro_owner": "You are part of {owner}'s team, led by **{lead}** (team lead). Your teammates:",
        "intro": "You are part of a team led by **{lead}** (team lead). Your teammates:",
        "rules": (
            "When part of your task clearly belongs to a teammate, ask them with the `ask_teammate` tool "
            "(teammate name + a complete, self-contained question: they do not see your conversation). "
            "`list_team` tells you who does what.\n"
            "- One precise question per need; use the answer in your work and credit the teammate "
            "(\"according to {example}…\").\n"
            "- Do not delegate what you can do yourself in a minute.\n"
            "- If you are already answering a teammate, you cannot ask anyone: answer with what you know.\n"
            "- You do not ask {lead} questions: say in your answer what is beyond your role or needs "
            "{decider}'s decision.\n"
        ),
        "decider_default": "the user",
    },
    "fr": {
        "heading": "## Ton équipe",
        "intro_owner": "Tu fais partie de l'équipe de {owner}, pilotée par **{lead}** (chef d'équipe). Tes collègues :",
        "intro": "Tu fais partie d'une équipe pilotée par **{lead}** (chef d'équipe). Tes collègues :",
        "rules": (
            "Quand une partie de ta tâche relève clairement d'un collègue, pose-lui la question avec l'outil "
            "`ask_teammate` (nom du collègue + question complète et autonome : il ne voit pas ta conversation). "
            "`list_team` te dit qui fait quoi.\n"
            "- Une seule question précise par besoin ; intègre la réponse dans ton travail en citant le collègue "
            "(« d'après {example}… »).\n"
            "- Ne délègue pas ce que tu fais toi-même en une minute.\n"
            "- Si tu réponds déjà à un collègue, tu ne peux relancer personne : réponds avec ce que tu sais.\n"
            "- Tu ne poses pas de question à {lead} : ce qui dépasse ton rôle ou demande une décision de "
            "{decider}, dis-le dans ta réponse.\n"
        ),
        "decider_default": "l'utilisateur",
    },
}


def get(path: str) -> dict:
    with urllib.request.urlopen(SIDE + path, timeout=30) as resp:
        return json.load(resp)


def post(payload: dict) -> dict:
    req = urllib.request.Request(SIDE + "/bot/update", data=json.dumps(payload, ensure_ascii=False).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)


def describe(bot: dict, lang: str) -> str:
    who = bot["display_name"] + (f", {bot['role']}" if bot.get("role") else "")
    colon = " : " if lang == "fr" else ": "
    return who + (colon + bot["description"] if bot.get("description") else "")


def section(t: dict, me: str, team: list, roster: dict, lead: str, owner: str) -> str:
    mates = [f"- **@{name}** — {line}" for name, line in roster.items() if name != me]
    example = next((b["display_name"] for b in team if b["name"] != me), lead)
    intro = (t["intro_owner"] if owner else t["intro"]).format(owner=owner, lead=lead)
    rules = t["rules"].format(lead=lead, example=example, decider=owner or t["decider_default"])
    return f"{t['heading']}\n{intro}\n" + "\n".join(mates) + "\n\n" + rules


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--lang", choices=sorted(TEXT), default="en", help="language of the section (default en)")
    ap.add_argument("--owner", default="", help="your name, as the bots should call you")
    ap.add_argument("--exclude", action="append", default=[], help="profile left out (repeatable)")
    ap.add_argument("--lead-soul", help="also replace the main profile's SOUL.md with this file")
    ap.add_argument("--dry-run", action="store_true", help="print the sections, change nothing")
    args = ap.parse_args()
    t = TEXT[args.lang]

    bots = get("/bots").get("bots") or []
    lead = next((b["display_name"] for b in bots if b["name"] == "default"), "Hermes")
    team = [b for b in bots if b["name"] != "default" and not b.get("hidden") and b["name"] not in args.exclude]
    if len(team) < 2:
        print("fewer than two bots on the team: nothing to do", file=sys.stderr)
        return 1
    roster = {b["name"]: describe(b, args.lang) for b in team}

    heading = re.escape(t["heading"])
    for bot in team:
        block = section(t, bot["name"], team, roster, lead, args.owner)
        if args.dry_run:
            print(f"── {bot['name']} ──\n{block}")
            continue
        soul = get("/bot/soul?bot=" + urllib.parse.quote(bot["name"]))["soul"]
        if re.search(rf"^{heading}\n", soul, flags=re.M):
            soul = re.sub(rf"^{heading}\n.*?(?=\n## |\Z)", block.rstrip("\n") + "\n", soul, flags=re.S | re.M)
        else:
            soul = soul.rstrip("\n") + "\n\n" + block
        print(bot["name"], post({"bot": bot["name"], "soul": soul}))

    if args.lead_soul and not args.dry_run:
        with open(args.lead_soul, encoding="utf-8") as fh:
            print("default", post({"bot": "default", "soul": fh.read()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
