"""Narration: text -> per-scene audio plan -> TTS (edge-tts if installed)
-> exact alignment table. The assemble stage uses the table so every
camera move lands exactly on its narration beat."""
import os
import subprocess

from . import config


def plan(scenes):
    """Cumulative narration schedule with scene start times (seconds)."""
    plan_rows, t = [], 0.0
    for i, sc in enumerate(scenes):
        dur = float(sc.get("duration", 8))
        pad = 0.8 if i else 1.6          # cold-open breath, then steady
        plan_rows.append({
            "scene": sc["name"],
            "index": i,
            "text": sc.get("narration", ""),
            "start_s": round(t + pad, 2),
            "duration_s": round(dur, 2),
            "audio": f"narration_{i:02d}_{sc['name']}.mp3",
        })
        t += dur + pad
    return plan_rows, round(t, 2)


def synthesize(workdir, plan_rows):
    """Generate MP3s via edge-tts (free, no key). Skips silently when
    edge-tts is not installed — the render script regenerates later."""
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        return {"ok": False, "reason": "edge-tts not installed (pip install edge-tts)"}
    audio_dir = os.path.join(workdir, "audio")
    os.makedirs(audio_dir, exist_ok=True)
    ok = 0
    for row in plan_rows:
        out = os.path.join(audio_dir, row["audio"])
        if os.path.exists(out) and os.path.getsize(out) > 1000:
            ok += 1
            continue
        try:
            subprocess.run(
                ["python", "-m", "edge_tts", "--voice", config.TTS_VOICE,
                 "--text", row["text"], "--write-media", out],
                check=True, timeout=120, capture_output=True)
            ok += 1
        except Exception as e:
            print(f"[tts] {row['scene']}: {e}")
    return {"ok": True, "generated": ok, "of": len(plan_rows)}


def write_srt(workdir, plan_rows):
    """Subtitles perfectly aligned to the narration table."""
    def fmt(sec):
        h = int(sec // 3600); m = int(sec % 3600 // 60); s = int(sec % 60)
        ms = int((sec - int(sec)) * 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"
    lines = []
    for i, row in enumerate(plan_rows, 1):
        start = row["start_s"]
        end = start + row["duration_s"] * 0.92
        lines += [str(i), f"{fmt(start)} --> {fmt(end)}", row["text"], ""]
    path = os.path.join(workdir, "subtitles.srt")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return path
