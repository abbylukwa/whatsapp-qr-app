"""Central configuration — environment-driven, sane defaults."""
import os

# ── AI provider (OpenAI-compatible chat/completions — any vendor) ──
# Priority: BLENDER_AI_KEY > first non-empty API_1..12 > OPENAI_API_KEY
def find_api_key():
    for k in ("BLENDER_AI_KEY", "OPENAI_API_KEY", "ZAI_API_KEY", "GROQ_API_KEY"):
        v = os.environ.get(k)
        if v:
            return v, os.environ.get("BLENDER_AI_URL") or _default_url_for(k, v)
    for i in range(1, 13):
        v = os.environ.get(f"API_{i}")
        if v:
            return v, os.environ.get(f"API_{i}_URL") or _default_url_for(f"API_{i}", v)
    return None, None

def _default_url_for(slot, key):
    if key.startswith("sk-or-v1-"):
        return "https://openrouter.ai/api/v1"
    if key.startswith("gsk_"):
        return "https://api.groq.com/openai/v1"
    if key.startswith("sk-"):
        return "https://api.openai.com/v1"
    return os.environ.get("BLENDER_AI_URL", "https://api.openai.com/v1")

API_KEY, API_URL = find_api_key()
API_MODEL = os.environ.get("BLENDER_AI_MODEL") or "gpt-4o-mini"

# ── Budgets (per film) ──
MAX_API_CALLS    = int(os.environ.get("BLENDER_MAX_API_CALLS", "120"))   # hard cap
MAX_RENDER_MIN   = int(os.environ.get("BLENDER_MAX_RENDER_MIN", "45"))   # target runtime cap
DEFAULT_FPS      = int(os.environ.get("BLENDER_FPS", "30"))
RENDER_ENGINE    = os.environ.get("BLENDER_ENGINE", "EEVEE")  # EEVEE | CYCLES
CYCLES_SAMPLES   = int(os.environ.get("BLENDER_CYCLES_SAMPLES", "128"))
RESOLUTION       = (int(os.environ.get("BLENDER_RES_X", "1920")),
                    int(os.environ.get("BLENDER_RES_Y", "1080")))

# ── Detail dials (the "recreating reality" levels) ──
HAIR_STRANDS      = int(os.environ.get("BLENDER_HAIR_STRANDS", "4500"))   # per scalp system
HAIR_CHILDREN     = int(os.environ.get("BLENDER_HAIR_CHILDREN", "8"))     # interpolated per strand
SUBDIV_HUMAN      = int(os.environ.get("BLENDER_SUBDIV_HUMAN", "2"))
SUBDIV_PROP       = int(os.environ.get("BLENDER_SUBDIV_PROP", "2"))
SKIN_SUBSURFACE   = float(os.environ.get("BLENDER_SKIN_SSS", "0.12"))     # subsurface weight

# ── Narration / TTS ──
TTS_ENGINE        = os.environ.get("BLENDER_TTS", "edge-tts")   # edge-tts | none
TTS_VOICE         = os.environ.get("BLENDER_TTS_VOICE", "en-GB-SoniaNeural")
WORDS_PER_SECOND  = 2.6    # narration pacing estimate (≈156 wpm documentary)

# ── Syllabus defaults ──
DEFAULT_SYLLABUS  = os.environ.get("BLENDER_SYLLABUS", "caps")   # caps | cambridge | custom file
DEFAULT_GRADE     = os.environ.get("BLENDER_GRADE", "10")
