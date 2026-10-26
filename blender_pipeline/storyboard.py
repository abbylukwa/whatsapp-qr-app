"""Storyboard: lesson + object briefs -> shot list with narration and
durations. The AI decides pacing/camera language when available; the
template engine guarantees a complete, correctly-timed storyboard."""
import math

from . import config


def estimate_duration(text, min_s=6.0, max_s=30.0):
    words = len(text.split())
    sec = words / config.WORDS_PER_SECOND
    return max(min_s, min(max_s, math.ceil(sec)))


def build(lesson, llm=None, state=None):
    grounding = lesson["grounding"]
    scenes_seed = grounding["scene_seed"]

    # AI storyboard pass (optional): rewrite scene descriptions, add shots
    scenes = [dict(s) for s in scenes_seed]
    if llm and llm.available_for_call():
        ai = llm.chat_json(
            "You are a documentary director planning an educational Blender "
            "film. Answer ONLY with JSON.",
            f'Lesson focus: {lesson["focus"]}\n'
            f'Environment: {grounding["environment"]}\n'
            f'Available objects: {[o["name"] for o in grounding["object_briefs"]]}\n'
            'Rewrite these scenes for the lesson. JSON only: {"scenes":'
            '[{"name":"snake_case","desc":"<what we SEE, camera action>",'
            '"mood":"<light + feeling>","narration":"<2-4 spoken sentences, '
            'grade-appropriate>"}]}',
            temperature=0.6,
        )
        if isinstance(ai, dict) and isinstance(ai.get("scenes"), list) and ai["scenes"]:
            scenes = ai["scenes"][:8]

    # Narration: AI text or grounded template narration
    for i, sc in enumerate(scenes):
        if not sc.get("narration"):
            sc["narration"] = template_narration(lesson, sc, i)
        sc.setdefault("mood", "warm natural light")
        sc.setdefault("desc", "Establishing shot")
        sc["duration"] = estimate_duration(sc["narration"])
        sc["shot"] = derive_shot(sc, i)

    # Camera style + pacing decided ONCE for the film
    film = {
        "camera_style": "slow dolly-ins, gentle orbits, rack focus to hands",
        "grade": lesson["grade"],
        "fps": config.DEFAULT_FPS,
        "resolution": config.RESOLUTION,
    }
    if state:
        state.api_call(700)
    return scenes, film


def derive_shot(scene, i):
    d = scene.get("desc", "").lower()
    if any(w in d for w in ("aerial", "reveal", "wide", "above")):
        return {"type": "aerial_orbit", "lens": 35, "aperture": 5.6}
    if any(w in d for w in ("close-up", "closeup", "hands", "detail")):
        return {"type": "close_up", "lens": 85, "aperture": 2.0}
    if any(w in d for w in ("night", "fire", "stars")):
        return {"type": "slow_push", "lens": 50, "aperture": 2.8}
    if i == 0:
        return {"type": "aerial_orbit", "lens": 35, "aperture": 5.6}
    return {"type": "dolly_in", "lens": 50, "aperture": 2.8}


def template_narration(lesson, scene, idx):
    env = lesson["grounding"]["environment"]
    name = scene.get("name", f"scene_{idx+1}")
    topic = lesson["topic"]
    templates = {
        "opening_dawn": f"{topic}. Long before written records, people already knew this land — every dune, every tree, every season.",
        "the_camp": "Home was whatever could be carried, built in an hour, and left without a trace. This is how they lived.",
        "making_tools": "Every tool tells a thought. Striking stone, straightening wood in the fire — technology older than farming itself.",
        "the_hunt": "A hunter read the ground like a book. One shadow, one footprint — and patience did the rest.",
        "gathering": "Most of the food never came from the hunt at all. Knowing which root, which berry, which season — that was knowledge too.",
        "firelight": "At night, around the fire, the day became a story. Stories were their library, their law, and their memory.",
        "rock_art": "And on the rock faces they painted what mattered — the animals, the dances, the rain. We are still reading them today.",
    }
    return templates.get(name, f"{scene.get('desc', '')} {lesson['focus']}")
