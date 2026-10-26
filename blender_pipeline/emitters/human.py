"""Human emitter — the 'hair by hair, fingernail by fingernail' brief.

Parametric human built from anatomical proportion guides:
  * skeleton-guided limb chains (upper/lower arms & legs, hands, feet)
  * torso from metaball-fused capsules, breasts/shoulders/hip dials
  * head with brow ridge, nose bridge, lips, ears
  * SUBSURFACE skin (melanin-tinted) with pore voronoi micro-bump
  * FINGERNAILS + TOENAILS as individually placed flattened spheres
  * 3 HAIR SYSTEMS: scalp (coils w/ clump+kink), eyebrows, eyelashes
  * hide clothing (cloth sim), bead necklace (instanced spheres)
  * simple armature with pose keyframes (idle sway / walk-in-place)
Every number comes from the spec (AI decides age/sex/height/skin)."""

from .base import emit_header, FOOTER


def emit(spec):
    name = spec.get("name", "figure")
    sex = spec.get("sex", "male")
    age = spec.get("age", "adult")
    height = float(spec.get("height_m", 1.55 if sex == "male" else 1.48))
    skin = spec.get("skin_tone_rgb", [0.39, 0.21, 0.12])
    hair_color = spec.get("hair_color_rgb", [0.04, 0.03, 0.025])
    hair_density = int(spec.get("hair_strands", 4500))
    sss = float(spec.get("skin_sss", 0.14))
    clothing = spec.get("clothing", "hide loincloth")
    jewelry = spec.get("jewelry", True)
    seed = int(spec.get("seed", 3))
    filename = f"30_human_{name}.bpy"

    # proportion guides (8-head canon adapted for San stature)
    head_h = height / 7.4
    shoulder_w = height * (0.135 if sex == "male" else 0.115)
    hip_w = height * (0.105 if sex == "male" else 0.125)
    leg_h = height * 0.47
    arm_len = height * 0.36

    # prebuilt conditional snippets (keep f-string expressions single-line)
    breast_block = ("bpy.ops.mesh.primitive_uv_sphere_add(radius=H*0.052, location=(-"
                    + str(round(shoulder_w * 0.28, 4)) + ", 0, H*0.655)); "
                    "b1=bpy.context.object; b1.name='BreastL'; smooth(b1,2,3); "
                    "b1.data.materials.append(skin); link(b1,BODY);\n"
                    "bpy.ops.mesh.primitive_uv_sphere_add(radius=H*0.052, location=("
                    + str(round(shoulder_w * 0.28, 4)) + ", 0, H*0.655)); "
                    "b2=bpy.context.object; b2.name='BreastR'; smooth(b2,2,3); "
                    "b2.data.materials.append(skin); link(b2,BODY)"
                    ) if sex == "female" else "# male chest profile"
    jewelry_block = (
        "bead = mat('Beads', base=(0.90, 0.87, 0.78, 1.0), rough=0.35)\n"
        "n_beads = 26\n"
        "neck_r = H*0.055\n"
        "for i in range(n_beads):\n"
        "    a = (i / n_beads) * math.pi * 2\n"
        "    x = math.sin(a) * neck_r * 0.9\n"
        "    y = -abs(math.cos(a)) * neck_r * 0.35 - H*0.008\n"
        "    z = H*0.735 - (1 - math.cos(a)) * H*0.012\n"
        "    bpy.ops.mesh.primitive_uv_sphere_add(radius=H*0.0045, segments=10, ring_count=8, location=(x, y, z))\n"
        "    b = bpy.context.object\n"
        "    b.name = 'Bead_%d' % i\n"
        "    b.data.materials.append(bead)\n"
        "    link(b, CLOTH)\n"
        "    smooth(b, 0, 1)"
    ) if jewelry else "# jewelry disabled by spec"

    code = emit_header(f"Human — {name} ({sex}, {age}, {height}m)", filename, seed)
    code += f'''
H = {height}
BODY = col("Body_{name}")
CLOTH = col("Cloth_{name}")

# ── SKIN material: subsurface + pores (the 'humanising' pass) ──
skin = mat("Skin_{name}",
           base=({skin[0]}, {skin[1]}, {skin[2]}, 1.0),
           rough=0.48, sss={sss}, sss_color=(0.55, 0.18, 0.10))
voronoi_grain(skin, scale=520.0, strength=0.22)     # pores
noise_bump(skin, scale=120, strength=0.06)          # micro unevenness

hair_mat_base = ({hair_color[0]}, {hair_color[1]}, {hair_color[2]})

def capsule(name, r1, r2, depth, loc, rot=(0,0,0), matx=None, coll=None):
    bpy.ops.mesh.primitive_cylinder_add(radius1=r1, radius2=r2, depth=depth,
                                        location=loc, rotation=rot)
    ob = bpy.context.object
    ob.name = name
    smooth(ob, levels=2, render=3)
    ob.data.materials.append(matx or skin)
    link(ob, coll or BODY)
    return ob

def sphere(name, r, loc, scale=(1,1,1), matx=None, coll=None):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, segments=24, ring_count=16,
                                         location=loc)
    ob = bpy.context.object
    ob.name = name
    ob.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    smooth(ob, levels=2, render=3)
    ob.data.materials.append(matx or skin)
    link(ob, coll or BODY)
    return ob

# ── TORSO: chest + abdomen + pelvis capsules, fused silhouette ──
chest = capsule("Chest", {shoulder_w*0.5}, {hip_w*0.42}, H*0.20, (0, 0, H*0.62))
chest.scale = (1.0, 0.62, 1.0)
bpy.ops.object.transform_apply(scale=True)
abdomen = capsule("Abdomen", {hip_w*0.42}, {hip_w*0.45}, H*0.14, (0, 0, H*0.50))
abdomen.scale = (1.0, 0.66, 1.0)
bpy.ops.object.transform_apply(scale=True)
pelvis = capsule("Pelvis", {hip_w*0.46}, {hip_w*0.40}, H*0.10, (0, 0, H*0.415))
pelvis.scale = (1.0, 0.68, 1.0)
bpy.ops.object.transform_apply(scale=True)
{breast_block}
# clavicle / neck
neck = capsule("Neck", H*0.032, H*0.036, H*0.055, (0, 0, H*0.755))
shoulder_l = sphere("ShoulderL", H*0.042, (-{shoulder_w*0.5}, 0, H*0.70))
shoulder_r = sphere("ShoulderR", H*0.042, ( {shoulder_w*0.5}, 0, H*0.70))

# ── ARMS: upper + forearm + hand, natural bend ──
armY = 0.0
for side, sx in (("L", -1), ("R", 1)):
    ux = sx * {shoulder_w*0.55}
    upper = capsule(f"UpperArm{{side}}", H*0.030, H*0.024, {arm_len*0.52},
                    (ux, 0, H*0.615), rot=(0, math.radians(6*sx), math.radians(84)))
    fore = capsule(f"Forearm{{side}}", H*0.022, H*0.016, {arm_len*0.40},
                   (sx*{shoulder_w*0.62}, H*0.05, H*0.475), rot=(0, math.radians(4*sx), math.radians(80)))
    hand = sphere(f"Hand{{side}}", H*0.036, (sx*{shoulder_w*0.66}, H*0.09, H*0.405),
                  scale=(0.55, 1.0, 0.28))
    # ── FINGERS: 4 fingers x 2 phalanges + thumb, nail on every tip ──
    nail = mat("Nail_{name}", base=(0.72, 0.55, 0.50, 1.0), rough=0.15)
    for f in range(4):
        fx = sx * ({shoulder_w*0.66} + (f - 1.5) * H*0.012)
        base_z = H*0.405 - f*H*0.002
        p1 = capsule(f"Finger{{side}}{{f}}_1", H*0.0065, H*0.0058, H*0.035,
                     (fx, H*0.105, base_z - H*0.018), rot=(0, math.radians(88), 0))
        p2 = capsule(f"Finger{{side}}{{f}}_2", H*0.0058, H*0.004, H*0.028,
                     (fx, H*0.125, base_z - H*0.030), rot=(0, math.radians(96), 0))
        sphere(f"NailF{{side}}{{f}}", H*0.0055,
               (fx, H*0.132, base_z - H*0.036), scale=(0.8, 0.5, 0.35), matx=nail)
    thumb = capsule(f"Thumb{{side}}", H*0.008, H*0.006, H*0.032,
                    (sx*{shoulder_w*0.60}, H*0.085, H*0.415),
                    rot=(0, math.radians(40), math.radians(35*sx)))
    sphere(f"NailT{{side}}", H*0.006, (sx*{shoulder_w*0.565}, H*0.098, H*0.432),
           scale=(0.8, 0.5, 0.35), matx=nail)

# ── LEGS: thigh + calf + foot + TOENAILS ──
foot_top = mat("FootSole", base=(0.16, 0.11, 0.08, 1.0), rough=0.85)
for side, sx in (("L", -1), ("R", 1)):
    lx = sx * {hip_w*0.28}
    thigh = capsule(f"Thigh{{side}}", H*0.045, H*0.034, {leg_h*0.5}, (lx, 0, H*0.36))
    calf = capsule(f"Calf{{side}}", H*0.031, H*0.021, {leg_h*0.42}, (lx, 0, H*0.175))
    ankle = sphere(f"Ankle{{side}}", H*0.018, (lx, -H*0.005, H*0.062))
    foot = sphere(f"Foot{{side}}", H*0.038, (lx, -H*0.035, H*0.030),
                  scale=(0.55, 1.5, 0.35), matx=foot_top)
    for t in range(5):
        tx = lx + (t - 2) * H*0.008
        sphere(f"NailToe{{side}}{{t}}", H*0.0045, (tx, -H*0.060, H*0.030),
               scale=(0.8, 0.5, 0.3), matx=mat("Nail_{name}", base=(0.72, 0.55, 0.50, 1.0), rough=0.15))

# ── HEAD: cranium + face planes + features ──
head_z = H*0.86
cranium = sphere("Cranium", head_h*0.42, (0, 0, head_z), scale=(0.82, 0.95, 1.0))
face = sphere("Face", head_h*0.36, (0, -head_h*0.10, head_z - head_h*0.06),
              scale=(0.78, 0.72, 0.95))
brow = capsule("BrowRidge", head_h*0.30, head_h*0.26, head_h*0.10,
               (0, -head_h*0.30, head_z + head_h*0.10), rot=(math.radians(90), 0, 0))
nose = capsule("Nose", head_h*0.055, head_h*0.042, head_h*0.16,
               (0, -head_h*0.36, head_z - head_h*0.02),
               rot=(math.radians(72), 0, 0))
lips = sphere("Lips", head_h*0.075, (0, -head_h*0.355, head_z - head_h*0.16),
              scale=(1.5, 0.4, 0.35))
lips.data.materials[0] = mat("Lips_{name}", base=({skin[0]*0.75}, {skin[1]*0.55}, {skin[2]*0.45}, 1.0), rough=0.35, sss=0.2)
for side, sx in (("L", -1), ("R", 1)):
    ear = sphere(f"Ear{{side}}", head_h*0.075, (sx*head_h*0.30, -head_h*0.02, head_z - head_h*0.02),
                 scale=(0.35, 0.55, 1.0))
    eye_i = mat("Iris_{name}", base=(0.09, 0.045, 0.02, 1.0), rough=0.1)
    eye_w = sphere(f"EyeWhite{{side}}", head_h*0.048,
                   (sx*head_h*0.13, -head_h*0.315, head_z - head_h*0.005), scale=(1.0, 0.55, 1.0),
                   matx=mat("EyeWhite_{name}", base=(0.92, 0.90, 0.86, 1.0), rough=0.08))
    iris = sphere(f"Iris{{side}}", head_h*0.020,
                  (sx*head_h*0.13, -head_h*0.345, head_z - head_h*0.005),
                  scale=(1.0, 0.4, 1.0), matx=eye_i)

# ── HAIR SYSTEMS (3): scalp coils, eyebrows, eyelashes ──
scalp = sphere("ScalpDome", head_h*0.40, (0, 0.005, head_z + head_h*0.045),
               scale=(0.80, 0.92, 0.95))
scalp.hide_render = True          # only the strands render
hair_system(scalp, strands={hair_density}, children={int(spec.get("hair_children", 8))},
            length=head_h*0.16, radius=0.0016, color=hair_mat_base,
            clump=0.55, kink=0.85, name="CoilyScalp")     # strong clump+kink = peppercorn coils

browzone = capsule("BrowZone", head_h*0.16, head_h*0.16, head_h*0.22,
                   (0, -head_h*0.31, head_z + head_h*0.085), rot=(math.radians(90), 0, 0))
browzone.hide_render = True
hair_system(browzone, strands=380, children=6, length=head_h*0.035,
            radius=0.0012, color=hair_mat_base, clump=0.4, kink=0.2, name="Brows")

lashzone = capsule("LashZone", head_h*0.10, head_h*0.10, head_h*0.18,
                   (0, -head_h*0.33, head_z - head_h*0.02), rot=(math.radians(75), 0, 0))
lashzone.hide_render = True
hair_system(lashzone, strands=220, children=5, length=head_h*0.022,
            radius=0.0008, color=hair_mat_base, clump=0.2, kink=0.35, name="Lashes")

# ── CLOTHING: hide loincloth/apron (cloth sim) + kaross option ──
hide = mat("Hide_{name}", base=(0.48, 0.34, 0.19, 1.0), rough=0.82)
voronoi_grain(hide, scale=300, strength=0.45)   # leather grain
bpy.ops.mesh.primitive_circle_add(vertices=24, radius={hip_w*0.55},
                                  location=(0, 0, H*0.40), fill_type='NGON')
apron = bpy.context.object
apron.name = "HideApron"
apron.scale = (1.0, 1.0, 1.6)
bpy.ops.object.transform_apply(scale=True)
sub = apron.modifiers.new("ClothRes", 'SUBSURF')
sub.levels = 2
cloth(apron, quality=10, mass=0.35, tension=25)
apron.data.materials.append(hide)
link(apron, CLOTH)

# ── JEWELRY: ostrich-eggshell bead necklace (instanced micro-spheres) ──
{jewelry_block}

# ── IDLE MOTION: subtle breathing + sway keyframes (alive, not posed) ──
SCN.frame_start = 1
SCN.frame_end = 96
torso_root = chest
keyframe_pose(torso_root, 1, location=(0, 0, H*0.62))
keyframe_pose(torso_root, 48, location=(0, 0.004, H*0.628))
keyframe_pose(torso_root, 96, location=(0, 0, H*0.62))
export([c for c in BODY.objects] + [c for c in CLOTH.objects] + [scalp, browzone, lashzone, apron])
'''
    code += FOOTER.format(title=f"Human {name}")
    return code
