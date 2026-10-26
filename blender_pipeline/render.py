"""Render planner: shell script that runs Blender over every .bpy in
order, exports GLBs, renders frames, then FFmpeg assembles the MP4 and
muxes narration audio + subtitles. Also emits a GitHub Actions workflow
for keyless CI rendering."""
import os
import stat

from . import config

RENDER_SH = r'''#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
#  blender_pipeline render plan — @@TOPIC@@
#  Requires: blender (3.6+), ffmpeg. Optional: edge-tts for audio.
#  Usage:  bash render.sh            (everything)
#          bash render.sh objects    (only object .bpy -> .glb)
#          bash render.sh assemble   (film assemble only)
#          bash render.sh frames     (render frames only)
# ═══════════════════════════════════════════════════════════════
set -e
cd "$(dirname "$0")"
BLENDER=${BLENDER:-blender}
STEP="${1:-all}"

run_bpy () {  # $1 = file
  echo "▶ $1"
  "$BLENDER" --background --python "$1" -- --out "$(pwd)/bpy" 2>&1 | tail -n 3
}

if [[ "$STEP" == "all" || "$STEP" == "objects" ]]; then
  for f in bpy/1*.bpy bpy/2*.bpy bpy/3*.bpy bpy/4*.bpy; do
    [[ -e "$f" ]] && run_bpy "$f"
  done
fi

if [[ "$STEP" == "all" || "$STEP" == "assemble" ]]; then
  run_bpy bpy/90_film_assemble.bpy
fi

if [[ "$STEP" == "all" || "$STEP" == "frames" ]]; then
  # render from the assembled file
  "$BLENDER" --background bpy/90_film_assemble.blend \
    --python-expr "import bpy; bpy.context.scene.frame_start=int(@@FSTART@@); bpy.context.scene.frame_end=int(@@FEND@@);" \
    -a 2>&1 | tail -n 5
fi

if [[ "$STEP" == "all" || "$STEP" == "video" ]]; then
  mkdir -p out
  # 1. silent film from frames
  ffmpeg -y -framerate @@FPS@@ -pattern_type glob -i 'frames/f_*.png' \
         -c:v libx264 -pix_fmt yuv420p -crf 18 out/film_silent.mp4

  # 2. v84.4 FIX: narration audio is now ACTUALLY muxed in.
  #    (The old step computed an adelay+amix graph, printed it, and threw
  #    it away — final.mp4 came out silent. It also fed adelay raw frame
  #    numbers as milliseconds, so even a wired graph would have been
  #    minutes off. Now python writes the input list + a REAL graph with
  #    start_f/fps*1000 ms delays, and bash runs ffmpeg with it.)
  AUDARGS=()
  if compgen -G "audio/narration_*.mp3" > /dev/null && [[ -f alignment.json ]]; then
    python3 - <<'PY'
import json, os
cfg = json.load(open('alignment.json'))
fps = float(cfg.get('fps', 24)) or 24.0
inputs, parts = [], []
for i, b in enumerate(cfg.get('beats', [])):
    f = "audio/narration_%02d_%s.mp3" % (i, b['scene'])
    if not os.path.exists(f):
        continue
    inputs.append(f)
    ms = int(round(int(b['start_f']) / fps * 1000))
    # ffmpeg input 0 = the silent film (video, no audio) — narration
    # files are inputs 1..N, so the audio stream specifier is i+1
    parts.append("[%d:a]adelay=%d:all=1[a%d]" % (len(inputs), ms, len(inputs) - 1))
open('audio/inputs.txt', 'w').write('\n'.join(inputs) + '\n')  # trailing newline: bash `while read` drops the last line without it
if inputs:
    # per-input delay chains, THEN a fresh segment whose input labels
    # feed amix:  [0:a]adelay=..[a0];[1:a]adelay=..[a1];[a0][a1]amix=..
    # (gluing the labels onto the previous filter = "No such filter: ''")
    graph = ';'.join(parts)
    graph += ';' + ''.join('[a%d]' % i for i in range(len(inputs)))
    graph += 'amix=inputs=%d:normalize=0[aout]' % len(inputs)
else:
    graph = ''
open('audio/filter.txt', 'w').write(graph)
PY
    while IFS= read -r f || [[ -n "$f" ]]; do [[ -n "$f" ]] && AUDARGS+=("-i" "$f"); done < audio/inputs.txt
  fi

  # 3. mux: burn subtitles into the video graph, mix narration in
  VGRAPH='[0:v]null[vout]'
  [[ -f subtitles.srt ]] && VGRAPH='[0:v]subtitles=subtitles.srt[vout]'
  if [[ ${#AUDARGS[@]} -gt 0 ]]; then
    GRAPH="$(cat audio/filter.txt)"
    ffmpeg -y -i out/film_silent.mp4 "${AUDARGS[@]}" \
      -filter_complex "$VGRAPH;$GRAPH" \
      -map "[vout]" -map "[aout]" \
      -c:v libx264 -pix_fmt yuv420p -crf 18 -c:a aac -shortest out/final.mp4 \
      && echo "✔ out/final.mp4 (narration + subtitles muxed)"
  else
    echo "⚠ no narration audio found (audio/narration_*.mp3) — final.mp4 will be SILENT"
    ffmpeg -y -i out/film_silent.mp4 -filter_complex "$VGRAPH" -map "[vout]" \
      -c:v libx264 -pix_fmt yuv420p -crf 18 out/final.mp4 \
      && echo "✔ out/final.mp4 (silent, subtitles only)"
  fi
fi
echo "DONE — see $(pwd)/out/"
'''

WORKFLOW = r'''name: Render educational film
on:
  workflow_dispatch:
    inputs:
      topic:
        description: 'Film topic'
        required: true
        default: 'The San people of the Kalahari'
jobs:
  plan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: {python-version: '3.11'}
      - run: pip install edge-tts
      - run: python -m blender_pipeline all --topic "${{ github.event.inputs.topic }}" --workdir work/film
      - uses: actions/upload-artifact@v4
        with: {name: bpy-scripts, path: work/film/bpy/}
  render:
    needs: plan
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: {python-version: '3.11'}
      - run: pip install edge-tts
      - run: python -m blender_pipeline all --topic "${{ github.event.inputs.topic }}" --workdir work/film
      - name: Install Blender
        run: |
          wget -q https://download.blender.org/release/Blender4.1/blender-4.1.1-linux-x64.tar.xz
          tar xf blender-4.1.1-linux-x64.tar.xz
          echo "BLENDER=$PWD/blender-4.1.1-linux-x64/blender" >> $GITHUB_ENV
      - run: BLENDER=$BLENDER bash work/film/render.sh all
      - uses: actions/upload-artifact@v4
        with: {name: final-film, path: work/film/out/}
'''


def write_render_plan(workdir, beats, fps, topic):
    frame_start = min(b["start_f"] for b in beats) if beats else 1
    frame_end = max(b["end_f"] for b in beats) if beats else 300
    script = (RENDER_SH.replace('@@TOPIC@@', topic).replace('@@FPS@@', str(fps))
              .replace('@@FSTART@@', str(frame_start)).replace('@@FEND@@', str(frame_end)))
    path = os.path.join(workdir, "render.sh")
    with open(path, "w") as f:
        f.write(script)
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    # GitHub Actions workflow (copy into .github if repo root detected)
    wf_dir = os.path.join(workdir, "gh-workflow")
    os.makedirs(wf_dir, exist_ok=True)
    wf_path = os.path.join(wf_dir, "render-film.yml")
    with open(wf_path, "w") as f:
        f.write(WORKFLOW)
    return path, wf_path
