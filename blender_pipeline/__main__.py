"""CLI entry: python -m blender_pipeline <cmd> [options].

Commands:
  plan      syllabus + AI film plan (topic -> scenes -> object list)
  objects   generate one detailed .bpy per object (object-by-object)
  narration build narration table + TTS audio (if edge-tts present)
  assemble  write the final cinematic .bpy + alignment.json
  renderp   write render.sh + GitHub Actions workflow
  all       everything above, resumable
  status    print progress summary
  demo      run 'all' offline (no API key) on the San people dossier
"""
import argparse
import json
import os
import sys

from . import config, state as state_mod, syllabus, knowledge, storyboard, narration, assemble, render as render_mod
from .llm import LLMClient
from .emitters import emit as emit_dispatch


def _plan(args):
    st = state_mod.TaskState(args.workdir)
    llm = LLMClient(st)
    if st.stage("syllabus") == "done" and not args.force:
        print("[plan] already done (use --force to redo)")
    else:
        topic = args.topic or st.data.get("topic") or "The San people of the Kalahari"
        grade = args.grade or st.data.get("grade") or config.DEFAULT_GRADE
        st.data["topic"] = topic
        st.data["grade"] = str(grade)
        lesson = syllabus.plan_lesson(topic, grade, args.syllabus or config.DEFAULT_SYLLABUS, llm, st)
        st.data["lesson"] = lesson
        st.stage("syllabus", "done")

    if st.stage("film_plan") == "done" and not args.force:
        print("[plan] film plan already done")
    else:
        lesson = st.data["lesson"]
        scenes, film = storyboard.build(lesson, llm, st)
        st.data["scenes"] = scenes
        st.data["film"] = film
        # object list: AI may refine, dossier guarantees ground truth
        objects = lesson["grounding"]["object_briefs"]
        if llm.available_for_call():
            ai = llm.chat_json(
                "You are a 3D asset director for an educational Blender film. "
                "Answer ONLY with JSON.",
                f'Lesson: {lesson["focus"]}\nEnvironment: {json.dumps(lesson["grounding"]["environment"])[:900]}\n'
                f'Current object briefs: {json.dumps(objects)[:1600]}\n'
                'Return {"objects":[{"kind":"terrain|spear|bow|human|fire|hut|animal|props",'
                '"name":"snake_case","notes":"detail brief","height_m":0,"hair_strands":0}]} '
                '— keep the good ones, correct proportions, max 12 objects.',
                temperature=0.5)
            if isinstance(ai, dict) and isinstance(ai.get("objects"), list) and ai["objects"]:
                objects = ai["objects"][:12]
            st.api_call(900)
        # merge spec defaults from config dials
        for o in objects:
            o.setdefault("kind", "props")
            o.setdefault("name", "object")
            if o["kind"] == "human":
                o.setdefault("hair_strands", config.HAIR_STRANDS)
                o.setdefault("hair_children", config.HAIR_CHILDREN)
                o.setdefault("skin_sss", config.SKIN_SUBSURFACE)
                hd = lesson["grounding"].get("human_details", {})
                if "skin_tone" in hd and "skin_tone_rgb" not in o:
                    o["skin_tone_rgb"] = hd["skin_tone"]
            o.setdefault("seed", abs(hash(o["name"])) % 1000)
            st.obj(o["name"], spec=o, status="planned")
        # guarantee a background environment (terrain) exists for the film
        if not any(o.get("kind") in ("terrain", "landscape") for o in objects):
            env = lesson["grounding"].get("environment", {})
            terrain_spec = {
                "kind": "terrain", "name": "environment",
                "terrain_desc": env.get("terrain", "open savanna"),
                "palette": env.get("palette", ["#c96f2e", "#d9a05b", "#b5a642"]),
                "seed": 7,
            }
            objects.insert(0, terrain_spec)
            st.obj("environment", spec=terrain_spec, status="planned")
        st.stage("film_plan", "done")

    st.save()
    print(json.dumps(st.summary(), indent=2))


def _objects(args):
    st = state_mod.TaskState(args.workdir)
    if not st.data["objects"]:
        sys.exit("no objects planned — run: python -m blender_pipeline plan ...")
    outdir = os.path.join(st.workdir, "bpy")
    os.makedirs(outdir, exist_ok=True)
    for name, rec in st.data["objects"].items():
        if rec.get("status") == "built" and not args.force:
            print(f"[obj] {name}: already built")
            continue
        spec = rec.get("spec") or {}
        try:
            prefix, sname, code = emit_dispatch(spec)
        except ValueError as e:
            print(f"[obj] {name}: SKIPPED — {e}")
            st.obj(name, status="error", error=str(e))
            continue
        fname = f"{prefix}_{sname}.bpy"
        path = os.path.join(outdir, fname)
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        st.obj(name, status="built", bpy=path)
        print(f"[obj] {name}: {fname} ({len(code)//1024}KB)")
    print(json.dumps(st.summary()["objects"], indent=2))


def _narration(args):
    st = state_mod.TaskState(args.workdir)
    scenes = st.data.get("scenes") or []
    if not scenes:
        sys.exit("no storyboard — run plan first")
    rows, total = narration.plan(scenes)
    st.data["narration"] = rows
    st.data["film"]["total_seconds"] = total
    st.stage("narration", "done")
    st.save()
    if not args.no_tts:
        res = narration.synthesize(st.workdir, rows)
        print("[tts]", res)
    srt = narration.write_srt(st.workdir, rows)
    print(f"[narration] {len(rows)} beats, total {total}s — srt: {srt}")


def _assemble(args):
    st = state_mod.TaskState(args.workdir)
    scenes = st.data.get("scenes") or []
    rows = st.data.get("narration") or narration.plan(scenes)[0]
    film = st.data.get("film", {})
    code = assemble.emit_assemble(st.workdir, film, scenes, rows)
    path = os.path.join(st.workdir, "bpy", "90_film_assemble.bpy")
    with open(path, "w", encoding="utf-8") as f:
        f.write(code)
    beats = [{"scene": r["scene"], "start_f": int(r["start_s"] * film.get("fps", config.DEFAULT_FPS)),
              "end_f": int((r["start_s"] + r["duration_s"]) * film.get("fps", config.DEFAULT_FPS))} for r in rows]
    assemble.write_alignment(st.workdir, beats, film.get("fps", config.DEFAULT_FPS))
    st.stage("assemble", "done")
    st.save()
    print(f"[assemble] {path} ({len(code)//1024}KB) — {len(scenes)} shots, "
          f"{beats[-1]['end_f'] if beats else 0} frames")


def _renderp(args):
    st = state_mod.TaskState(args.workdir)
    rows = st.data.get("narration") or []
    fps = st.data.get("film", {}).get("fps", config.DEFAULT_FPS)
    beats = [{"scene": r["scene"], "start_f": int(r["start_s"] * fps),
              "end_f": int((r["start_s"] + r["duration_s"]) * fps)} for r in rows]
    sh, wf = render_mod.write_render_plan(st.workdir, beats, fps, st.data.get("topic", "film"))
    st.stage("render_plan", "done")
    st.save()
    print(f"[renderp] {sh}\n[renderp] CI workflow: {wf} (copy to .github/workflows/ to render on GitHub)")


def _all(args):
    args.force = getattr(args, "force", False)
    _plan(args)
    _objects(args)
    args.no_tts = False
    _narration(args)
    _assemble(args)
    _renderp(args)
    print("\nNEXT: run on a Blender machine →  bash " +
          os.path.join(args.workdir, "render.sh"))


def _status(args):
    st = state_mod.TaskState(args.workdir)
    print(json.dumps(st.summary(), indent=2))


def _demo(args):
    """Full offline run proving the pipeline (San people, grade 10)."""
    args.topic = "The San people of the Kalahari"
    args.grade = "10"
    args.syllabus = "caps"
    args.workdir = args.workdir or os.path.join("work", "san_demo")
    args.force = True
    _all(args)


def main():
    p = argparse.ArgumentParser(prog="blender_pipeline")
    sub = p.add_subparsers(dest="cmd", required=True)

    def common(sp):
        sp.add_argument("--workdir", default="work/film")
        sp.add_argument("--force", action="store_true")

    sp = sub.add_parser("plan");  common(sp)
    sp.add_argument("--topic"); sp.add_argument("--grade")
    sp.add_argument("--syllabus")
    sp.set_defaults(fn=_plan)

    sp = sub.add_parser("objects"); common(sp); sp.set_defaults(fn=_objects)

    sp = sub.add_parser("narration"); common(sp)
    sp.add_argument("--no-tts", action="store_true")
    sp.set_defaults(fn=_narration)

    sp = sub.add_parser("assemble"); common(sp); sp.set_defaults(fn=_assemble)
    sp = sub.add_parser("renderp");  common(sp); sp.set_defaults(fn=_renderp)
    sp = sub.add_parser("status");   common(sp); sp.set_defaults(fn=_status)

    sp = sub.add_parser("all"); common(sp)
    sp.add_argument("--topic"); sp.add_argument("--grade"); sp.add_argument("--syllabus")
    sp.set_defaults(fn=_all)

    sp = sub.add_parser("demo"); common(sp); sp.set_defaults(fn=_demo)

    args = p.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
