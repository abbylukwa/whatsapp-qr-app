"""Fire, hut, animal (quadruped), and props emitters."""
from .base import emit_header, FOOTER


def emit_fire(spec):
    name = spec.get("name", "campfire")
    seed = int(spec.get("seed", 5))
    code = emit_header(f"Campfire — {name}", f"40_fire_{name}.bpy", seed)
    code += r'''
# ── STONES ring (rigid, real placement) ──
stone = mat("FireStone", base=(0.30, 0.26, 0.22, 1.0), rough=0.9)
voronoi_grain(stone, scale=140, strength=0.5)
stones = []
for i in range(9):
    a = i / 9 * math.pi * 2 + random.uniform(-0.1, 0.1)
    r = 0.42 + random.uniform(-0.05, 0.05)
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, radius=0.07 + random.random()*0.04,
        location=(math.cos(a)*r, math.sin(a)*r, 0.035))
    s = bpy.context.object
    s.name = f"RingStone_{i}"
    s.scale = (1, 0.8 + random.random()*0.3, 0.6)
    s.data.materials.append(stone)
    rigid(s, mass=1.2, bounces=False)
    stones.append(s)

# ── LOGS: charred wood teepee ──
char = mat("CharWood", base=(0.05, 0.035, 0.03, 1.0), rough=0.92)
wave_grain(char, scale=18, distortion=5, strength=0.5)
logs = []
for i in range(5):
    a = i / 5 * math.pi * 2
    bpy.ops.mesh.primitive_cylinder_add(radius1=0.025, radius2=0.018, depth=0.45,
        location=(math.cos(a)*0.09, math.sin(a)*0.09, 0.16),
        rotation=(math.radians(math.degrees(math.atan2(0.09, 0.30))), a, 0))
    lg = bpy.context.object
    lg.name = f"Log_{i}"
    lg.data.materials.append(char)
    logs.append(lg)

# ── FLAME: cone with animated noise-driven emission shader ──
bpy.ops.mesh.primitive_cone_add(vertices=16, radius1=0.14, radius2=0.02,
                                depth=0.55, location=(0, 0, 0.42))
flame = bpy.context.object
flame.name = "Flame"
fm = bpy.data.materials.new("FlameMat")
fm.use_nodes = True
nt = fm.node_tree
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Alpha"].default_value = 0.0
bsdf.inputs["Emission Color"].default_value = (1.0, 0.45, 0.08, 1.0)
bsdf.inputs["Emission Strength"].default_value = 28.0
tex = nt.nodes.new("ShaderNodeTexNoise")
tex.inputs["Scale"].default_value = 6.0
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].color = (1.0, 0.85, 0.2, 1)
ramp.color_ramp.elements[1].color = (0.9, 0.15, 0.02, 1)
nt.links.new(tex.outputs["Fac"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], bsdf.inputs["Emission Color"])
fm.blend_method = 'BLEND'
flame.data.materials.append(fm)
smooth(flame, 2, 3)

# animate flame flicker: scale + emission strength keyframes
SCN.frame_start = 1
SCN.frame_end = 120
flame.keyframe_insert(data_path="scale", frame=1)
flame.scale = (1.06, 1.06, 0.94)
flame.keyframe_insert(data_path="scale", frame=14)
flame.scale = (0.95, 0.97, 1.05)
flame.keyframe_insert(data_path="scale", frame=29)
flame.scale = (1.03, 0.96, 0.97)
flame.keyframe_insert(data_path="scale", frame=47)
for f in (1, 30, 60, 90, 120):
    SCN.frame_set(f)
    bsdf.inputs["Emission Strength"].keyframe_insert("default_value", frame=f)

# ── FIRELIGHT: point light with flicker (this lights the night scene) ──
light_data = bpy.data.lights.new("FireLight", 'POINT')
light_data.energy = 220
light_data.color = (1.0, 0.55, 0.22)
light_data.shadow_soft_size = 0.12
light_ob = bpy.data.objects.new("FireLight", light_data)
link(light_ob)
light_ob.location = (0, 0, 0.55)
light_ob.keyframe_insert(data_path="energy", frame=1)
light_data.energy = 260
light_ob.keyframe_insert(data_path="data.energy", frame=9)
light_data.energy = 190
light_ob.keyframe_insert(data_path="data.energy", frame=21)
light_data.energy = 245
light_ob.keyframe_insert(data_path="data.energy", frame=33)

export([flame, light_ob] + stones + logs)
'''
    code += FOOTER.format(title=f"Fire {name}")
    return code


def emit_hut(spec):
    name = spec.get("name", "grass_hut")
    seed = int(spec.get("seed", 9))
    code = emit_header(f"Hut — {name}", f"41_hut_{name}.bpy", seed)
    code += f'''
# ── FRAME: bent-sapling dome (lattice of arcs) ──
sapling = mat("Sapling", base=(0.30, 0.22, 0.12, 1.0), rough=0.85)
R = 1.6
arcs = []
for i in range(8):
    a = i / 8 * math.pi * 2
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=0.022,
        location=(0, 0, 0), rotation=(0, math.radians(90), a))
    arc = bpy.context.object
    arc.name = f"FrameArc_{{i}}"
    arc.scale = (1, 1, 0.72)          # squashed dome profile
    bpy.ops.object.transform_apply(scale=True)
    # cut lower half by moving below floor
    arc.location = (0, 0, -0.35)
    arc.data.materials.append(sapling)
    arcs.append(arc)

# ── THATCH: dome shell of displaced straw material + grass fringe ──
bpy.ops.mesh.primitive_uv_sphere_add(radius=R, segments=32, ring_count=20,
                                     location=(0, 0, 0))
dome = bpy.context.object
dome.name = "Thatch"
dome.scale = (1.0, 1.0, 0.78)
bpy.ops.object.transform_apply(scale=True)
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.select_all(action='INVERT') if False else None
bpy.ops.object.mode_set(mode='OBJECT')
thatch = mat("Thatch", base=(0.55, 0.42, 0.18, 1.0), rough=0.9)
noise_bump(thatch, scale=60, strength=0.6)
voronoi_grain(thatch, scale=200, strength=0.35)
dome.data.materials.append(thatch)
solidify(dome, thickness=0.05)
smooth(dome, 1, 2)
# sink below ground so only the dome shows
dome.location = (0, 0, -R * 0.45)

# ── DOORWAY: dark tunnel (simple boolean-look via low entrance disc) ──
bpy.ops.mesh.primitive_cylinder_add(radius=0.42, depth=0.9,
    location=(0, -R*0.78, 0.30), rotation=(math.radians(90), 0, 0))
door = bpy.context.object
door.name = "DoorwayShadow"
door.display_type = 'WIRE'
door.hide_render = True

export(arcs + [dome])
'''
    code += FOOTER.format(title=f"Hut {name}")
    return code


def emit_animal(spec):
    """Quadruped (eland/antelope) — parametric body, spiral horns."""
    name = spec.get("name", "eland")
    body_len = float(spec.get("body_len_m", 2.2))
    shoulder_h = float(spec.get("shoulder_h_m", 1.5))
    horns = spec.get("horns", "spiral")
    coat = spec.get("coat_rgb", [0.55, 0.42, 0.28])
    seed = int(spec.get("seed", 13))
    code = emit_header(f"Animal — {name}", f"42_animal_{name}.bpy", seed)
    code += f'''
L = {body_len}
H = {shoulder_h}
coat = mat("Coat_{name}", base=({coat[0]}, {coat[1]}, {coat[2]}, 1.0), rough=0.72, sss=0.05)
noise_bump(coat, scale=90, strength=0.25)     # fur micro-texture
hair_system_bake = None

# ── BODY: barrel + chest + rump fused ──
bpy.ops.mesh.primitive_uv_sphere_add(radius=L*0.16, location=(0, 0, H*0.66))
torso = bpy.context.object
torso.name = "Torso"
torso.scale = (1.9, 0.85, 1.0)
bpy.ops.object.transform_apply(scale=True)
smooth(torso, 2, 3)
torso.data.materials.append(coat)

bpy.ops.mesh.primitive_uv_sphere_add(radius=L*0.10, location=(L*0.22, 0, H*0.72))
chest = bpy.context.object
chest.name = "Chest"
chest.scale = (1.0, 0.8, 1.1)
bpy.ops.object.transform_apply(scale=True)
smooth(chest, 2, 3)
chest.data.materials.append(coat)

bpy.ops.mesh.primitive_uv_sphere_add(radius=L*0.11, location=(-L*0.24, 0, H*0.70))
rump = bpy.context.object
rump.name = "Rump"
smooth(rump, 2, 3)
rump.data.materials.append(coat)

# neck + head (long antelope neck)
neck = bpy.context.object = None
bpy.ops.mesh.primitive_cylinder_add(radius1=L*0.06, radius2=L*0.045, depth=L*0.30,
    location=(L*0.30, 0, H*0.90), rotation=(0, math.radians(-35), 0))
neck = bpy.context.object
neck.name = "Neck"
smooth(neck, 2, 3)
neck.data.materials.append(coat)
bpy.ops.mesh.primitive_uv_sphere_add(radius=L*0.075, location=(L*0.38, 0, H*1.02))
head = bpy.context.object
head.name = "Head"
head.scale = (1.5, 0.75, 0.9)
bpy.ops.object.transform_apply(scale=True)
smooth(head, 2, 3)
head.data.materials.append(coat)

# muzzle + ears + eyes
bpy.ops.mesh.primitive_cylinder_add(radius1=L*0.035, radius2=L*0.025, depth=L*0.10,
    location=(L*0.48, 0, H*0.99), rotation=(0, math.radians(-90), 0))
muzzle = bpy.context.object
muzzle.name = "Muzzle"
muzzle.data.materials.append(coat)
for sx in (-1, 1):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=L*0.022,
        location=(L*0.36, sx*L*0.055, H*1.06))
    ear = bpy.context.object
    ear.name = f"Ear_{{'L' if sx<0 else 'R'}}"
    ear.scale = (0.4, 1.2, 0.8)
    bpy.ops.object.transform_apply(scale=True)
    ear.rotation_euler = (math.radians(20*sx), 0, sx*0.5)
    ear.data.materials.append(coat)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=L*0.012,
        location=(L*0.44, sx*L*0.045, H*1.03))
    eye = bpy.context.object
    eye.name = f"Eye_{{'L' if sx<0 else 'R'}}"
    eye.data.materials.append(mat("EyeDark", base=(0.03, 0.02, 0.02, 1.0), rough=0.1))

# ── HORNS: spiral (screw deform on a cone) ──
for sx in (-1, 1):
    bpy.ops.mesh.primitive_cone_add(radius1=L*0.02, radius2=0.002, depth=L*0.28,
        location=(L*0.33, sx*L*0.035, H*1.16))
    horn = bpy.context.object
    horn.name = f"Horn_{{'L' if sx<0 else 'R'}}"
    sd = horn.modifiers.new("Spiral", 'SCREW')
    sd.angle = math.radians(720)
    sd.screw_offset = 0.0
    horn.rotation_euler = (0, math.radians(15), sx*math.radians(18))
    horn.data.materials.append(mat("Horn", base=(0.35, 0.28, 0.18, 1.0), rough=0.5))
    smooth(horn, 1, 2)

# ── LEGS: 4 slender with hooves ──
for (lx, sx, tag) in ((L*0.16, -0.5, "FrontL"), (L*0.16, 0.5, "FrontR"),
                      (-L*0.18, -0.5, "BackL"), (-L*0.18, 0.5, "BackR")):
    bpy.ops.mesh.primitive_cylinder_add(radius1=L*0.022, radius2=L*0.014, depth=H*0.55,
        location=(lx, sx*L*0.075, H*0.30))
    leg = bpy.context.object
    leg.name = f"Leg_{{tag}}"
    leg.data.materials.append(coat)
    bpy.ops.mesh.primitive_cylinder_add(radius1=L*0.018, radius2=L*0.016, depth=H*0.07,
        location=(lx, sx*L*0.075, H*0.035))
    hoof = bpy.context.object
    hoof.name = f"Hoof_{{tag}}"
    hoof.data.materials.append(mat("Hoof", base=(0.12, 0.09, 0.07, 1.0), rough=0.45))

# ── COAT HAIR: sparse fine fur over torso ──
hair_system(torso, strands=2500, children=6, length=L*0.012, radius=0.0009,
            color=({coat[0]*0.8}, {coat[1]*0.8}, {coat[2]*0.8}), clump=0.15, kink=0.2,
            name="Fur")

# ground contact shadow catcher handled by assemble; simple walk-cycle skip here
export([torso, chest, rump, neck, head])
'''
    code += FOOTER.format(title=f"Animal {name}")
    return code


def emit_props(spec):
    """Rock art panel, ostrich egg flasks, digging stick, quiver."""
    name = spec.get("name", "rock_art_panel")
    seed = int(spec.get("seed", 17))
    code = emit_header(f"Props — {name}", f"43_props_{name}.bpy", seed)
    code += r'''
# ── ROCK ART PANEL: granite boulder + painted figures via emission-tinted noise masks ──
bpy.ops.mesh.primitive_cube_add(size=2.2, location=(0, 0, 0.9))
rock = bpy.context.object
rock.name = "RockPanel"
rock.scale = (1.6, 0.35, 1.1)
bpy.ops.object.transform_apply(scale=True)
d = rock.modifiers.new("Weathered", 'DISPLACE')
wt = bpy.data.textures.new("Weather", type='CLOUDS')
wt.noise_scale = 0.8
d.texture = wt
d.strength = 0.12
bevel(rock, 0.05, 4)
smooth(rock, 1, 2)
smart_uv(rock)

granite = mat("GranitePanel", base=(0.42, 0.38, 0.34, 1.0), rough=0.9)
voronoi_grain(granite, scale=220, strength=0.55)

# ochre paint layer: wave-driven color ramp in an overlay material
paint = bpy.data.materials.new("OchrePaint")
paint.use_nodes = True
nt = paint.node_tree
bsdf = nt.nodes["Principled BSDF"]
bsdf.inputs["Roughness"].default_value = 0.85
wave = nt.nodes.new("ShaderNodeTexWave")
wave.inputs["Scale"].default_value = 3.0
wave.inputs["Distortion"].default_value = 12.0
ramp = nt.nodes.new("ShaderNodeValToRGB")
ramp.color_ramp.elements[0].position = 0.48
ramp.color_ramp.elements[0].color = (0.42, 0.38, 0.34, 1)   # granite
ramp.color_ramp.elements[1].color = (0.55, 0.16, 0.07, 1)   # red ochre figures
nt.links.new(wave.outputs["Fac"], ramp.inputs["Fac"])
nt.links.new(ramp.outputs["Color"], bsdf.inputs["Base Color"])
rock.data.materials.append(paint)

# ── OSTRICH EGG WATER FLASKS (2) with beaded net ──
eggshell = mat("Eggshell", base=(0.88, 0.85, 0.76, 1.0), rough=0.42)
flasks = []
for i, (fx, fy) in enumerate(((0.9, -0.5), (1.15, -0.15))):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.075, location=(fx, fy, 0.075))
    egg = bpy.context.object
    egg.name = f"OstrichFlask_{i}"
    egg.scale = (0.85, 0.85, 1.25)
    bpy.ops.object.transform_apply(scale=True)
    smooth(egg, 2, 3)
    egg.data.materials.append(eggshell)
    noise_bump(eggshell, scale=200, strength=0.08)
    flasks.append(egg)

# ── DIGGING STICK with weighted head ──
bpy.ops.mesh.primitive_cylinder_add(radius1=0.018, radius2=0.024, depth=1.1,
                                    location=(-1.1, 0.3, 0.55),
                                    rotation=(math.radians(12), 0, math.radians(30)))
stick = bpy.context.object
stick.name = "DiggingStick"
stick.data.materials.append(mat("StickWood", base=(0.25, 0.15, 0.08, 1.0), rough=0.8))
wave_grain(stick.data.materials[0], scale=30, distortion=6, strength=0.5)

export([rock] + flasks + [stick])
'''
    code += FOOTER.format(title=f"Props {name}")
    return code
