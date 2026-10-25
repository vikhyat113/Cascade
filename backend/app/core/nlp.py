"""Natural-language request parsing: "I finish at 2:15 and need to reach Sector 12 by 3".

Rule-based parser always runs. If GROQ_API_KEY is set, an LLM is asked to
extract the same fields as JSON; its output is schema-validated and only used
to fill gaps. The LLM never supplies facts (places are resolved against the
local OSM gazetteer, times against the sim clock).
"""
from __future__ import annotations

import json
import os
import re
from typing import Optional

from pydantic import BaseModel, ValidationError, field_validator

TIME = r"(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?"
NEED_MAP = {"medicine": "medicine", "medicines": "medicine", "pharmacy": "pharmacy", "chemist": "pharmacy",
            "food": "food", "something to eat": "food", "atm": "atm", "cash": "atm", "hospital": "hospital",
            "doctor": "hospital", "police": "police", "fuel": "fuel", "petrol": "fuel", "toilet": "toilets",
            "washroom": "toilets"}
STOP = r"(?=\s+(?:by|before|at|until|around|from|and|then|so|but)\b|[,.!?]|$)"


class ParsedRequest(BaseModel):
    finish_time: Optional[str] = None
    start_time: Optional[str] = None
    deadline: Optional[str] = None
    destination_text: Optional[str] = None
    origin_text: Optional[str] = None
    modes: Optional[list[str]] = None
    risk_weight: Optional[float] = None
    need: Optional[str] = None

    @field_validator("finish_time", "start_time", "deadline")
    @classmethod
    def _hhmm(cls, v):
        if v is None:
            return v
        if not re.fullmatch(r"\d{2}:\d{2}", v):
            raise ValueError("time must be HH:MM")
        return v

    @field_validator("modes")
    @classmethod
    def _modes(cls, v):
        if v is None:
            return v
        return [m for m in v if m in ("walk", "bus", "cab", "metro")] or None


def _fmt(h: str, m: Optional[str], ap: Optional[str]) -> Optional[str]:
    hh, mm = int(h), int(m or 0)
    ap = (ap or "").lower().replace(".", "")
    if hh > 23 or mm > 59:
        return None
    if ap == "pm" and hh < 12:
        hh += 12
    elif ap == "am" and hh == 12:
        hh = 0
    elif not ap:
        if hh == 12:
            hh = 0                    # night context: "12:30" means 00:30
        elif 7 <= hh <= 11:
            hh += 12                  # "finish at 10" on a night shift = 22:00
    return f"{hh:02d}:{mm:02d}"


def parse_rules(text: str) -> ParsedRequest:
    t = " " + text.lower().strip() + " "
    out = ParsedRequest()
    m = re.search(r"(?:finish|finishing|finished|done|off|end|ends|get off|shift ends?)\s*(?:work|my shift|shift|duty)?"
                  r"\s*(?:at|around|by|@)?\s*" + TIME, t)
    if m:
        out.finish_time = _fmt(*m.groups())
    m = re.search(r"(?:leave|leaving|start|starting|depart|departing|go)\s*(?:at|around|@)\s*" + TIME, t)
    if m:
        out.start_time = _fmt(*m.groups())
    m = re.search(r"(?:\bby|\bbefore|\buntil|\btill|no later than)\s*" + TIME + r"(?!\s*(?:min|km|m\b))", t)
    if m:
        out.deadline = _fmt(*m.groups())
    if re.search(r"\b(?:get|go|reach|be|need|want)\s+(?:back\s+)?home\b|\bto home\b|\bhome by\b", t):
        out.destination_text = "home"
    else:
        m = re.search(r"\b(?:reach|get to|go to|going to|head to|towards|to)\s+(?!be\b|get\b|reach\b|go\b|the bus\b)"
                      r"([a-z0-9][\w\s\-/&'.]*?)" + STOP, t)
        if m and not re.fullmatch(r"\d+(?:[:.]\d+)?\s*(?:am|pm)?", m.group(1).strip()):
            out.destination_text = m.group(1).strip().title()
    m = re.search(r"\b(?:from|i'?m at|i am at|i'?m in|i am in|work(?:ing)? at|at work in)\s+([a-z0-9][\w\s\-/&'.]*?)"
                  r"(?=\s+(?:to|and|i\b|by|at)\b|[,.!?]|$)", t)
    if m:
        out.origin_text = m.group(1).strip().title()
    if re.search(r"\bno (?:cab|taxi|auto)s?\b|\bwithout (?:a )?(?:cab|taxi)", t):
        out.modes = ["walk", "bus"]
    elif re.search(r"\bwalk(?:ing)? only\b|\bon foot\b", t):
        out.modes = ["walk"]
    elif re.search(r"\b(?:by|take a|take the) bus\b|\bbus only\b", t):
        out.modes = ["walk", "bus"]
    if re.search(r"\bsafe(?:st)?\b|\bsafely\b", t):
        out.risk_weight = 0.9
    elif re.search(r"\bfast(?:est)?\b|\bquick(?:est|ly)?\b|\bhurry\b", t):
        out.risk_weight = 0.3
    m = re.search(r"\b(?:need|want|looking for|find|get)\s+(?:an?\s+|some\s+|to\s+)?(" + "|".join(NEED_MAP) + r")\b", t)
    if m:
        out.need = NEED_MAP[m.group(1)]
    return out


def parse_llm(text: str) -> Optional[ParsedRequest]:
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        return None
    import httpx
    sys_prompt = (
        "You extract fields from a night-shift worker's travel request. Reply with ONE JSON object with keys: "
        "finish_time, start_time, deadline (24h 'HH:MM', assume night: '2' means 02:00, '10' means 22:00), "
        "destination_text, origin_text (place names exactly as written, or 'home'), modes (subset of walk, bus, cab), "
        "risk_weight (0..1, 1 = safest), need (one of medicine, pharmacy, food, atm, hospital, police, fuel, toilets). "
        "Use null for anything not stated. Never invent places, times or facts.")
    try:
        r = httpx.post("https://api.groq.com/openai/v1/chat/completions", timeout=6,
                       headers={"Authorization": f"Bearer {key}"},
                       json={"model": os.environ.get("GROQ_MODEL", "llama-3.1-8b-instant"), "temperature": 0,
                             "response_format": {"type": "json_object"},
                             "messages": [{"role": "system", "content": sys_prompt},
                                          {"role": "user", "content": text}]})
        r.raise_for_status()
        data = json.loads(r.json()["choices"][0]["message"]["content"])
        return ParsedRequest(**{k: data.get(k) for k in ParsedRequest.model_fields})
    except (httpx.HTTPError, KeyError, ValueError, ValidationError, json.JSONDecodeError):
        return None


def parse(text: str, geocode=None) -> dict:
    rules = parse_rules(text)
    llm = parse_llm(text)
    merged = rules.model_copy()
    used = "rules"
    if llm is not None:
        used = "groq+rules"
        for k in ParsedRequest.model_fields:
            if getattr(merged, k) is None and getattr(llm, k) is not None:
                setattr(merged, k, getattr(llm, k))
    out = merged.model_dump()
    out["parser"] = used
    out["destination"] = out["origin"] = None
    if geocode:
        for side in ("destination", "origin"):
            q = out[f"{side}_text"]
            if q and q != "home":
                hits = geocode(q)
                out[side] = hits[0] if hits else None
                out[f"{side}_candidates"] = hits[:5]
                if not hits:
                    out.setdefault("warnings", []).append(
                        f"'{q}' is not in the offline map gazetteer: pick it on the map (not guessed).")
    filled = sum(1 for k in ("finish_time", "start_time", "deadline", "destination_text") if out[k])
    out["confidence"] = round(min(1.0, filled / 3), 2)
    return out
