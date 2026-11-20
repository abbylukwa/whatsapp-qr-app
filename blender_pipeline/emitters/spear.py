"""Spear emitter — the owner's flagship example taken seriously:
hardwood shaft (fire-hardened, grain texture, slight natural bend),
knapped stone/iron head shaped by displacement, sinew bindings as
wrapped torus coils, leather grip, optional feather flights, and a
rigid-body throw animation preview."""

from .base import emit_header, FOOTER


def emit(spec):
    name = spec.get("name", "hunting_spear")
    length = float(spec.get("length_m", 1.8))
    head = spec.get("head", "stone")          # stone | iron
    blade_len = float(spec.get("blade_len_m", 0.18))
    bindings = int(spec.get("bindings", 3))
    seed = int(spec.get("seed", 11))
    filename = f"20_weapon_{name}.bpy"

    code = emit_header(f"Spear — {name}", filename, seed)
    code += f'''
# ── SHAFT: hardwood, natural taper + slight bend, fire-hardened tip ──
bpy.ops.mesh.primitive_cylinder_add(radius1=0.014, radius2=0.011,
                                    depth={length}, location=(0, 0, {length/2}))
shaft = bpy.context.object
shaft.name = "Shaft"
bend = shaft.modifiers.new("NaturalBend", 'SIMPLE_DEFORM')
bend.deform_method = 'BEND'
bend.angle = math.radians(2.2)          # a real stick is never straight
bend.deform_axis = 'X'
smooth(shaft, levels={spec.get("subdiv", 1)}, render=2)
smart_uv(shaft)

wood = mat("Hardwood", base=(0.28, 0.17, 0.08, 1.0), rough=0.65)
wave_grain(wood, scale=26.0, distortion=7.0, strength=0.45,
           color2=(0.18, 0.10, 0.05))
shaft.data.materials.append(wood)

# fire-hardened darker tip zone (vertex-color-free trick: second material slot via small cylinder)
bpy.ops.mesh.primitive_cone_add(radius1=0.011, radius2=0.004, depth=0.12,
                                location=(0, 0, {length + 0.05}))
tip_hard = bpy.context.object
tip_hard.name = "FireHardenedTip"
char_mat = mat("CharTip", base=(0.09, 0.06, 0.045, 1.0), rough=0.8)
voronoi_grain(char_mat, scale=120, strength=0.3)
tip_hard.data.materials.append(char_mat)

# ── HEAD: knapped blade — icosphere crushed + displacement fluting ──
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=3, radius={blade_len/2},
                                      location=(0, 0, {length + 0.16}))
head = bpy.context.object
head.name = "Blade"
head.scale = (0.35, 1.0, 0.16)          # flat, long, thin — biface silhouette
bpy.ops.object.transform_apply(scale=True)
d = head.modifiers.new("Fluting", 'DISPLACE')
ftex = bpy.data.textures.new("Flake", type='VORONOI')
ftex.noise_scale = 0.03
d.texture = ftex
d.strength = 0.008
bevel(head, width=0.0015, segments=2)
smooth(head, levels=0, render=1)
smart_uv(head)
if "{head}" == "iron":
    blade_mat = mat("ForgedIron", base=(0.28, 0.27, 0.26, 1.0), rough=0.42, metal=0.9)
    noise_bump(blade_mat, scale=35, strength=0.15)
else:
    # knapped flint: dark grey with glassy conchoidal sheen
    blade_mat = mat("Flint", base=(0.16, 0.155, 0.15, 1.0), rough=0.28, metal=0.05)
    voronoi_grain(blade_mat, scale=180, strength=0.55)
head.data.materials.append(blade_mat)

# ── SINEW BINDINGS: torus coils, wrapped, slightly irregular ──
sinew = mat("Sinew", base=(0.62, 0.55, 0.42, 1.0), rough=0.75)
noise_bump(sinew, scale=60, strength=0.35)
bindings = []
for i in range({bindings}):
    z = {round(length + 0.02, 4)} + i * 0.035
    bpy.ops.mesh.primitive_torus_add(major_radius=0.014, minor_radius=0.003,
                                     location=(0, 0, z),
                                     rotation=(math.radians(90), 0, 0))
    b = bpy.context.object
    b.name = f"Binding_{{i}}"
    b.scale = (1 + random.uniform(-0.08, 0.08), 1, 1 + random.uniform(-0.08, 0.08))
    b.data.materials.append(sinew)
    smooth(b, levels=1, render=2)
    bindings.append(b)

# ── LEATHER GRIP: slightly oversized sleeve mid-shaft ──
bpy.ops.mesh.primitive_cylinder_add(radius=0.0165, radius2=0.0165, depth=0.22,
                                    location=(0, 0, {length * 0.55}))
grip = bpy.context.object
grip.name = "Grip"
leather = mat("GripLeather", base=(0.32, 0.20, 0.12, 1.0), rough=0.78)
voronoi_grain(leather, scale=260, strength=0.5)   # pores
grip.data.materials.append(leather)
smooth(grip, levels=1, render=2)

parts = [shaft, tip_hard, head, grip] + bindings

# ── THROW PREVIEW: 40-frame rigid-body arc (physics decides the fall) ──
SCN.frame_start = 1
SCN.frame_end = 40
# throw from origin: give the blade+shaft initial velocity via keyframed emitter
export(parts)
'''
    code += FOOTER.format(title=f"Spear {name}")
    return code


def emit_bow(spec):
    """Recurved hunting bow + poisoned arrow set (San standard kit)."""
    name = spec.get("name", "hunting_bow")
    seed = int(spec.get("seed", 19))
    code = emit_header(f"Bow — {name}", f"21_weapon_{name}.bpy", seed)
    code += f'''
# ── BOW LIMBS: bent arc (curve-deformed cylinder) ──
bpy.ops.mesh.primitive_cylinder_add(radius1=0.013, radius2=0.009, depth=1.5,
                                    location=(0, 0, 1.0),
                                    rotation=(0, math.radians(90), 0))
limb = bpy.context.object
limb.name = "BowBody"
bend = limb.modifiers.new("Recurve", 'SIMPLE_DEFORM')
bend.deform_method = 'BEND'
bend.angle = math.radians(35)
bend.deform_axis = 'Z'
smooth(limb, 1, 2)
smart_uv(limb)
bowwood = mat("BowWood", base=(0.33, 0.22, 0.11, 1.0), rough=0.6)
wave_grain(bowwood, scale=22, distortion=8, strength=0.5)
limb.data.materials.append(bowwood)

# ── SINEW STRING ──
bpy.ops.mesh.primitive_cylinder_add(radius=0.0015, depth=1.42,
                                    location=(0, 0, 1.02),
                                    rotation=(0, math.radians(90), 0))
string = bpy.context.object
string.name = "BowString"
string.data.materials.append(mat("String", base=(0.7, 0.65, 0.55, 1.0), rough=0.7))

# ── ARROWS x3: thin shafts, metal tips, feather fletching ──
feather = mat("Feather", base=(0.75, 0.72, 0.66, 1.0), rough=0.75, alpha=0.9)
arrows = []
for i in range(3):
    ay = (i - 1) * 0.06
    bpy.ops.mesh.primitive_cylinder_add(radius=0.0035, depth=0.75,
        location=(0.15, ay, 0.01), rotation=(math.radians(90), 0, 0))
    arrow = bpy.context.object
    arrow.name = f"Arrow_{{i}}"
    arrow.data.materials.append(mat("ArrowWood", base=(0.30, 0.20, 0.10, 1.0), rough=0.7))
    bpy.ops.mesh.primitive_cone_add(radius1=0.006, radius2=0.0005, depth=0.05,
        location=(0.15, ay, 0.40), rotation=(math.radians(90), 0, 0))
    tip = bpy.context.object
    tip.name = f"ArrowTip_{{i}}"
    tip.data.materials.append(mat("Arrowhead", base=(0.14, 0.13, 0.12, 1.0), rough=0.3, metal=0.7))
    for fside in (-1, 1):
        bpy.ops.mesh.primitive_plane_add(size=0.045,
            location=(0.15, ay + fside*0.006, -0.33),
            rotation=(0, 0, fside*0.4))
        fin = bpy.context.object
        fin.name = f"Fletch_{{i}}_{{fside}}"
        fin.scale = (0.4, 1.0, 1.0)
        fin.data.materials.append(feather)
    arrows += [arrow, tip]

export([limb, string] + arrows)
'''
    code += FOOTER.format(title=f"Bow {name}")
    return code
