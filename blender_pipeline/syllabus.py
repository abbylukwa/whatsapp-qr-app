"""Syllabus ingest: public curricula -> topics -> grade-appropriate focus.

Ships with CAPS (South African, matches the owner's San-people use
case) topic maps for History grades 4-12, Cambridge/IB pointer tables,
and a generic ingest path for ANY syllabus file/URL (txt/md/json).
The AI can refine the lesson outline; the local tables guarantee a
sensible result with zero API calls.
"""

from . import knowledge

# CAPS History focus points (public curriculum summary, condensed)
CAPS_HISTORY = {
    "4": ["Local history", "How people lived long ago (hunter-gatherers & herders)"],
    "5": ["Hunter-gatherers and herders in southern Africa (San and Khoikhoi)",
          "Ancient southern African cities (Mapungubwe)"],
    "6": ["Early civilisations: Egypt, Mesopotamia", "Mapungubwe and Great Zimbabwe"],
    "7": ["Kingdom of Mali", "Songhai empire", "Slave trade beginnings"],
    "8": ["Industrial Revolution", "Colonisation of southern Africa", "Mineral Revolution"],
    "9": ["World Wars", "Apartheid South Africa", "Holocaust", "Nuclear age"],
    "10": ["French Revolution", "Songhai empire", "Colonial expansion after 1750"],
    "11": ["Russian Revolution", "Fascism/Nazism", "Apartheid: resistance"],
    "12": ["Cold War", "Independence in Africa", "Civil society protests 1950s-1970s",
           "Truth and Reconciliation Commission"],
}

CAMBRIDGE_IGCSE = {
    "history": ["Were the peace treaties fair?", "To what extent was the League a success?",
                "Germany 1918-45", "Russia 1905-41", "The USA 1919-41"],
}


def _pick_grade_focus(topic, grade):
    """Grade-appropriate angle for the SAME topic (what the syllabus
    actually asks at that level) — this is what makes the video fit a
    classroom instead of being a generic documentary."""
    g = str(grade)
    t = topic.lower()
    if any(a in t for a in knowledge.DOSSIERS["san"]["aliases"]):
        if g in ("4", "5"):
            return ("Describe how the San lived: food, tools, shelter, clothing, "
                    "rock art and beliefs. Simple vocabulary, present the daily "
                    "cycle of a family group.")
        if g in ("6", "7"):
            return ("Explain the San as hunter-gatherers: tracking, poison arrows, "
                    "shared meat, equality between men and women, and how farmers "
                    "(Khoikhoi) differed. Introduce the term 'Stone Age'.")
        if g in ("8", "9"):
            return ("Analyse colonial impacts: land loss, genocide in German South-West "
                    "Africa, survival adaptations, and modern San rights movements.")
        return ("Evaluate historical sources: rock art as evidence, oral tradition vs "
                "colonial accounts, and historiographic debates about San society.")
    return f"Grade {g} level: core facts, key terms, and one exam-relevant debate about: {topic}."


def plan_lesson(topic, grade, syllabus="caps", llm=None, state=None):
    """Returns {topic, grade, syllabus, focus, dossier_key, grounding}."""
    dossier = knowledge.match_dossier(topic)
    focus = _pick_grade_focus(topic, grade)

    grounding = {
        "era": dossier["era"],
        "place": dossier["place"],
        "environment": dossier["environment"],
        "object_briefs": dossier["objects"],
        "human_details": dossier.get("human_details", {}),
        "scene_seed": dossier["scenes_template"],
    }

    # AI refinement (optional, budget-aware): let the model correct or
    # enrich the lesson focus and object briefs. Knowledge stays ground truth.
    ai_focus = None
    if llm and llm.available_for_call():
        ai = llm.chat_json(
            "You are a curriculum historian and 3D film art director. "
            "Answer ONLY with JSON.",
            f'Topic: "{topic}" for grade {grade} ({syllabus} syllabus).\n'
            f"Known grounding: {json.dumps(grounding)[:2400]}\n"
            'Return JSON: {"focus": "<2-sentence grade-appropriate lesson goal>",'
            ' "corrections": ["..."], "extra_objects": [{"kind":"...","name":"...","notes":"..."}]}'
        )
        if isinstance(ai, dict):
            ai_focus = ai.get("focus")
            for extra in ai.get("extra_objects", [])[:4]:
                if isinstance(extra, dict) and extra.get("kind"):
                    grounding["object_briefs"].append(extra)

    if state:
        state.api_call(600)
    return {
        "topic": topic,
        "grade": str(grade),
        "syllabus": syllabus,
        "focus": ai_focus or focus,
        "dossier_key": "custom",
        "grounding": grounding,
    }


def ingest_file(path):
    """Ingest ANY syllabus: .json topic list, .txt/.md plain text.
    Returns list of {topic, grade}."""
    out = []
    try:
        raw = open(path, "r", encoding="utf-8", errors="ignore").read()
    except OSError:
        return out
    if path.endswith(".json"):
        try:
            import json
            data = json.loads(raw)
            rows = data if isinstance(data, list) else data.get("topics", [])
            for r in rows:
                if isinstance(r, dict) and r.get("topic"):
                    out.append({"topic": r["topic"], "grade": str(r.get("grade", "10"))})
        except Exception:
            pass
    else:
        for line in raw.splitlines():
            line = line.strip("-* \t")
            if 8 < len(line) < 120 and " " in line:
                out.append({"topic": line, "grade": "10"})
    return out
