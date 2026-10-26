"""Terrain emitter — displaced dune landscape with grass tufts, rocks,
acacia trees. Params come from the spec (AI or knowledge dossier)."""

from .base import emit_header, FOOTER


def _rgb(hexstr):
    h = (hexstr or "#c96f2e").lstrip("#")
    try:
        return tuple(round(int(h[i:i + 2], 16) / 255.0, 4) for i in (0, 2, 4))
    except (ValueError, IndexError):
        return (0.788, 0.435, 0.180)


def emit(spec):
    name = spec.get("name", "landscape")
    palette = spec.get("palette", ["#c96f2e", "#d9a05b", "#b5a642"])
    # resolve palette to float rgb in the GENERATOR (keeps emitted code clean)
    sand_rgb = _rgb(palette[0])
    dry_rgb = _rgb(palette[1])
    grass_rgb = _rgb(palette[2]) if len(palette) > 2 else (0.710, 0.651, 0.259)
    dunes_amp = float(spec.get("dune_amplitude", 0.6))
    grass_count = int(spec.get("grass_tufts", 180))
    rock_count = int(spec.get("rocks", 12))
    acacias = int(spec.get("acacia_trees", 5))
    seed = int(spec.get("seed", 7))
    terrain_desc = spec.get("terrain_desc", "open savanna")

    code = emit_header(f"Terrain — {name} ({terrain_desc})", f"10_terrain_{name}.bpy", seed)
    code += f'''
# ── GROUND: subdivided plane, dual-noise displaced dunes ──
bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
ground = bpy.context.object
ground.name = "Ground"
bpy.ops.object.mode_set(mode='EDIT')
bpy.ops.mesh.subdivide(number_cuts=140, smoothness=0.9)
bpy.ops.object.mode_set(mode='OBJECT')
m = ground.modifiers.new("Dunes", 'DISPLACE')
tex = bpy.data.textures.new("DuneTex", type='CLOUDS')
tex.noise_scale = 9.0
m.texture = tex
m.strength = {dunes_amp}
m2 = ground.modifiers.new("Dune_detail", 'DISPLACE')
tex2 = bpy.data.textures.new("DuneFine", type='CLOUDS')
tex2.noise_scale = 2.2
m2.texture = tex2
m2.strength = {round(dunes_amp * 0.25, 4)}
# large-scale sand ripples
m3 = ground.modifiers.new("Ripples", 'WAVE')
m3.use_x = True
m3.use_y = True
m3.wave_scale = 3.5
m3.wave_height = 0.03
smooth(ground, levels=1, render=2)
smart_uv(ground)

sand = mat("Sand", base=({sand_rgb[0]}, {sand_rgb[1]}, {sand_rgb[2]}, 1.0), rough=0.92)
voronoi_grain(sand, scale=90.0, strength=0.35)
noise_bump(sand, scale=14.0, strength=0.2)
ground.data.materials.append(sand)

# ── GRASS TUFTS: instanced blade bundles via particle hair ──
bpy.ops.mesh.primitive_cone_add(vertices=4, radius1=0.008, depth=0.28, location=(0,0,-10))
blade = bpy.context.object
blade.name = "BladeProto"
grass_mat = mat("DryGrass", base=({grass_rgb[0]}, {grass_rgb[1]}, {grass_rgb[2]}, 1.0), rough=0.85)
wave_grain(grass_mat, scale=30, distortion=8, strength=0.4)
blade.data.materials.append(grass_mat)
bpy.ops.object.select_all(action='DESELECT')
blade.select_set(True)
bpy.context.view_layer.objects.active = blade
ps = ground.modifiers.new("Grass", 'PARTICLE_SYSTEM')
p = ps.particle_system.settings
p.type = 'HAIR'
p.count = {grass_count}
p.hair_length = 0.3
p.instance_object = blade
p.child_type = 'INTERPOLATED'
p.child_percent = 4
p.rendered_child_percent = 8
p.distribution = 'RAND'
p.use_rotations = True
p.rotation_mode = 'GLOB_Z'
p.rotation_factor_random = 0.35

# ── ROCKS: icospheres + knapped displacement + rigid bodies ──
rock_mat = mat("Granite", base=({dry_rgb[0]}, {dry_rgb[1]}, {dry_rgb[2]}, 1.0), rough=0.85)
voronoi_grain(rock_mat, scale=45, strength=0.5)
rocks = []
for i in range({rock_count}):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2,
        radius=0.12 + random.random() * 0.35,
        location=(random.uniform(-18, 18), random.uniform(-18, 18), 0.05))
    r = bpy.context.object
    r.name = "Rock_%02d" % i
    r.scale = (1, 0.8 + random.random() * 0.4, 0.55 + random.random() * 0.3)
    d = r.modifiers.new("Knapped", 'DISPLACE')
    dt = bpy.data.textures.new("RockTex_%d" % i, type='VORONOI')
    dt.noise_scale = 0.35
    d.texture = dt
    d.strength = 0.06
    smooth(r, levels=1, render=2)
    r.data.materials.append(rock_mat)
    rigid(r, mass=2.5, bounces=False)
    rocks.append(r)

# ── ACACIA TREES: tapered trunk + flat umbrella canopy ──
bark = mat("AcaciaBark", base=(0.16, 0.11, 0.07, 1.0), rough=0.9)
wave_grain(bark, scale=20, distortion=6, strength=0.5)
leaf = mat("AcaciaLeaf", base=(0.20, 0.26, 0.09, 1.0), rough=0.8)
noise_bump(leaf, scale=40, strength=0.3)
trees = []
for i in range({acacias}):
    tx, ty = random.uniform(-20, 20), random.uniform(-20, 20)
    h = 2.6 + random.random() * 1.4
    bpy.ops.mesh.primitive_cylinder_add(radius1=0.10, radius2=0.05, depth=h, location=(tx, ty, h/2))
    trunk = bpy.context.object
    trunk.name = "AcaciaTrunk_%d" % i
    d = trunk.modifiers.new("Twist", 'SIMPLE_DEFORM')
    d.deform_method = 'TWIST'
    d.angle = math.radians(random.uniform(-25, 25))
    trunk.data.materials.append(bark)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=1.4 + random.random()*0.5, location=(tx, ty, h + 0.15))
    canopy = bpy.context.object
    canopy.name = "AcaciaCanopy_%d" % i
    canopy.scale = (1.6, 1.6, 0.35)
    displace_noise(canopy, strength=0.35, scale=1.4)
    canopy.data.materials.append(leaf)
    smooth(canopy, levels=1, render=2)
    trees += [trunk, canopy]

rigid(ground, mass=0, bounces=False)  # static ground collider

export([ground, blade] + rocks + trees)
'''
    code += FOOTER.format(title=f"Terrain {name}")
    return code
