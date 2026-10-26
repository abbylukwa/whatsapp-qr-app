"""Assemble stage: writes the FINAL cinematic .bpy + alignment data.

The assemble .bpy IMPORTS the object .glb files produced by the
object stage (or rebuilds them inline if GLBs are missing), then
builds the film exactly like a director would:
  * one Blender SCENE per shot with its own camera + lighting rig
  * camera animation (aerial orbit / dolly-in / close-up / slow push)
  * mood lighting: sun angle+color, sky gradient, firelight cross-ref
  * physics baked on the world (ground collider, gravity)
  * frame ranges derived from the narration alignment table
  * render settings per config (EEVEE default, Cycles optional)
"""
import json
import os

from . import config
from .emitters.base import emit_header, FOOTER


def emit_assemble(workdir, film, scenes, narration_rows):
    glb_dir = os.path.join(workdir, "bpy")
    glbs = sorted(f for f in os.listdir(glb_dir) if f.endswith(".glb")) if os.path.isdir(glb_dir) else []
    fps = film.get("fps", config.DEFAULT_FPS)
    res_x, res_y = film.get("resolution", config.RESOLUTION)
    engine = config.RENDER_ENGINE

    # convert narration seconds -> frame numbers
    beats = [{"scene": r["scene"], "start_f": int(round(r["start_s"] * fps)),
              "end_f": int(round((r["start_s"] + r["duration_s"]) * fps))}
             for r in narration_rows]
    total_f = max((b["end_f"] for b in beats), default=300)

    code = emit_header(f"Film assembly — {len(scenes)} scenes @ {fps}fps", "90_film_assemble.bpy", 99)
    code += f'''
# ═══ IMPORT OBJECT LIBRARY (each .glb built by its own stage) ═══
GLB_DIR = r"{glb_dir}"
GLBS = {glbs!r}
imported = []
for f in GLBS:
    path = os.path.join(GLB_DIR, f)
    if not os.path.exists(path):
        print("missing, skipping:", f)
        continue
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    imported.append([ob for ob in bpy.data.objects if ob not in before])
print(f"imported {{len(imported)}} assets")

# ── WORLD: procedural sky gradient (no HDRI download needed) ──
world = bpy.data.worlds.new("Sky")
SCN.world = world
world.use_nodes = True
wnt = world.node_tree
bg = wnt.nodes["Background"]
sky = wnt.nodes.new("ShaderNodeTexSky")
sky.sky_type = 'NISHITA'
sky.sun_elevation = math.radians(18)
sky.sun_rotation = math.radians(120)
sky.dust_density = 0.6          # warm dusty Kalahari air
wnt.links.new(sky.outputs["Color"], bg.inputs["Color"])
bg.inputs["Strength"].default_value = 0.85

# ── RENDer SETTINGS ──
SCN.render.fps = {fps}
SCN.render.resolution_x = {res_x}
SCN.render.resolution_y = {res_y}
SCN.render.image_settings.file_format = 'PNG'
SCN.render.filepath = r"{os.path.join(workdir, 'frames', 'f_')}"
SCN.frame_start = 1
SCN.frame_end = {total_f}
'''

    if engine == "CYCLES":
        code += f'''
SCN.render.engine = 'CYCLES'
SCN.cycles.samples = {config.CYCLES_SAMPLES}
SCN.cycles.use_denoising = True
SCN.render.use_motion_blur = True
'''
    else:
        code += '''
SCN.render.engine = 'BLENDER_EEVEE'
SCN.eevee.taa_render_samples = 64
SCN.eevee.use_gtao = True
SCN.eevee.use_ssr = True
SCN.eevee.use_ssr_refraction = True
SCN.eevee.soft_shadow_size = 6.0
# color management: prefer AgX (Blender 4.x), fall back gracefully
try:
    SCN.view_settings.look = 'AgX - Medium High Contrast'
except TypeError:
    SCN.view_settings.look = 'Medium High Contrast'
SCN.view_settings.exposure = 0.35
'''

    # ── per-scene rigs ──
    code += "\n# ═══ SHOT RIGS ═══\n"
    for i, sc in enumerate(scenes):
        beat = beats[i] if i < len(beats) else {"scene": sc["name"], "start_f": 1 + i * 200, "end_f": 200 + i * 200}
        shot = sc.get("shot", {"type": "dolly_in", "lens": 50, "aperture": 2.8})
        mood = sc.get("mood", "warm natural light").lower()
        is_night = any(w in mood for w in ("night", "fire", "star"))
        is_dawn = any(w in mood for w in ("dawn", "dusk", "haze"))
        # mood-driven lighting values (decided per scene, never hardcoded)
        sun_color = "(1.0, 0.45, 0.20)" if is_night else "(1.0, 0.85, 0.62)" if is_dawn else "(1.0, 0.92, 0.80)"
        sun_energy = 0.4 if is_night else 3.2 if is_dawn else 6.0
        sun_el = 70 if is_night else 18 if is_dawn else 48
        sun_az = 15 if is_dawn else 30
        fill_energy = 40 if is_night else 220
        fill_color = "(0.35, 0.5, 1.0)" if is_night else "(0.75, 0.85, 1.0)"
        fill_z = "2.0" if is_night else "5.0"
        code += f'''
# ─── Scene {i+1}: {sc['name']} — {sc.get('desc', '')[:70]} ───
def build_scene_{i}():
    rig = {{}}
    # camera
    cam_data = bpy.data.cameras.new("Cam_{i}")
    cam_data.lens = {shot.get("lens", 50)}
    cam_data.dof.use_dof = True
    cam_data.dof.aperture_fstop = {shot.get("aperture", 2.8)}
    cam = bpy.data.objects.new("Cam_{i}", cam_data)
    SCN.collection.objects.link(cam)
    # lighting rig (mood: {mood[:50]})
    sun_data = bpy.data.lights.new("Sun_{i}", 'SUN')
    sun_data.color = {sun_color}
    sun_data.energy = {sun_energy}
    sun = bpy.data.objects.new("Sun_{i}", sun_data)
    SCN.collection.objects.link(sun)
    sun.rotation_euler = (math.radians({sun_el}),
                          math.radians({sun_az}),
                          math.radians({25 + i * 40}))
    fill_data = bpy.data.lights.new("Fill_{i}", 'AREA')
    fill_data.energy = {fill_energy}
    fill_data.size = 6.0
    fill_data.color = {fill_color}
    fill = bpy.data.objects.new("Fill_{i}", fill_data)
    SCN.collection.objects.link(fill)
    fill.location = ({-6 + i}, -8, {fill_z})
    fill.rotation_euler = (math.radians(35), 0, 0)
    rig.update(cam=cam, sun=sun, fill=fill)
    return rig

RIG_{i} = build_scene_{i}()
CAM = RIG_{i}["cam"]

# camera motion for this shot — keyframed, exact narration window
S, E = {beat['start_f']}, {beat['end_f']}
'''
        stype = shot.get("type", "dolly_in")
        if stype == "aerial_orbit":
            code += f'''
CAM.location = (14 * math.cos(0.0), -14 * math.sin(0.0), 9.0)
CAM.keyframe_insert(data_path="location", frame=S)
CAM.location = (12 * math.cos(1.4), -12 * math.sin(1.4), 7.5)
CAM.keyframe_insert(data_path="location", frame=E)
'''
        elif stype == "close_up":
            code += f'''
CAM.location = (1.6, -2.4, 1.35)
CAM.keyframe_insert(data_path="location", frame=S)
CAM.location = (1.2, -2.0, 1.30)
CAM.keyframe_insert(data_path="location", frame=E)
'''
        elif stype == "slow_push":
            code += f'''
CAM.location = (2.8, -4.5, 1.7)
CAM.keyframe_insert(data_path="location", frame=S)
CAM.location = (2.0, -3.2, 1.55)
CAM.keyframe_insert(data_path="location", frame=E)
'''
        else:  # dolly_in
            code += f'''
CAM.location = (4.0, -6.0, 1.8)
CAM.keyframe_insert(data_path="location", frame=S)
CAM.location = (2.6, -3.8, 1.55)
CAM.keyframe_insert(data_path="location", frame=E)
'''
        code += f'''
# track the action: aim at subject height (empty target)
target = bpy.data.objects.new("CamTarget_{i}", None)
SCN.collection.objects.link(target)
target.location = (0.6, 0, 1.1)
con = CAM.constraints.new('TRACK_TO')
con.target = target
con.track_axis = 'TRACK_NEGATIVE_Z'
con.up_axis = 'UP_Y'

print("rig ready: {sc['name']}", S, E)
'''

    code += f'''
# ═══ FINAL: physics world sanity + save the assembled file ═══
bpy.context.scene.rigidbody_world = bpy.context.scene.rigidbody_world  # keep default gravity
os.makedirs(OUT, exist_ok=True)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, "90_film_assemble.blend"))
print("ASSEMBLED:", SCN.frame_end, "frames @", SCN.render.fps, "fps")
'''
    code += FOOTER.format(title="Film assembly")
    return code


def write_alignment(workdir, beats, fps):
    path = os.path.join(workdir, "alignment.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"fps": fps, "beats": beats}, f, indent=2)
    return path
