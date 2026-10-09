# Headless Blender script: procedural gunship -> AO bake -> Draco GLB
# Blender coords: +Y forward (nose), +Z up. glTF export maps to three: (x, z, -y) => nose toward -Z.
import bpy, bmesh, math, random, os
from mathutils import Vector, Matrix
OUT = os.environ.get('OUT', '/workspace/canyon-flight/assets')
random.seed(7)
bpy.ops.wm.read_factory_settings(use_empty=True)
scn = bpy.context.scene

def mat(name, col, metal, rough, emit=None, es=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*col, 1); b.inputs['Metallic'].default_value = metal; b.inputs['Roughness'].default_value = rough
    if emit: b.inputs['Emission Color'].default_value = (*emit, 1); b.inputs['Emission Strength'].default_value = es
    return m
M = {
  'hull': mat('hull', (0.05, 0.05, 0.056), 0.85, 0.38), 'panel': mat('panel', (0.075, 0.075, 0.08), 0.8, 0.5),
  'dark': mat('dark', (0.02, 0.02, 0.022), 0.5, 0.62), 'glass': mat('glass', (0.02, 0.03, 0.04), 0.9, 0.06),
  'nozzle': mat('nozzle', (0.16, 0.13, 0.11), 1.0, 0.32), 'hot': mat('hot', (1, 0.45, 0.1), 0, 0.5, (1, 0.42, 0.08), 8),
  'navR': mat('navR', (1, 0.1, 0.05), 0, 0.5, (1, 0.12, 0.05), 6), 'navG': mat('navG', (0.1, 1, 0.3), 0, 0.5, (0.1, 1, 0.3), 6),
  'accent': mat('accent', (0.55, 0.22, 0.04), 0.4, 0.45),
}
parts = []
def obj_from(bm, name, m):
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); scn.collection.objects.link(o); o.data.materials.append(M[m]); parts.append(o); return o
def mods(o, bevel=0.0, seg=2, sub=0, smooth=True, angle=40):
    bpy.context.view_layer.objects.active = o
    if bevel > 0:
        b = o.modifiers.new('bev', 'BEVEL'); b.width = bevel; b.segments = seg; b.limit_method = 'ANGLE'; b.angle_limit = math.radians(30)
    if sub: s = o.modifiers.new('sub', 'SUBSURF'); s.levels = sub; s.render_levels = sub
    for p in o.data.polygons: p.use_smooth = smooth
    o.data.set_sharp_from_angle(angle=math.radians(angle)) if hasattr(o.data, 'set_sharp_from_angle') else None
    return o

def loft(name, sections, m, n=24, cap=True, expo=2.6):
    """sections: list of (y, w, h, zc) -> superellipse rings"""
    bm = bmesh.new(); rings = []
    for (y, w, h, zc) in sections:
        ring = []
        for i in range(n):
            a = 2 * math.pi * i / n; c, s = math.cos(a), math.sin(a)
            x = (abs(c) ** (2 / expo)) * math.copysign(1, c) * w / 2
            z = (abs(s) ** (2 / expo)) * math.copysign(1, s) * h / 2 + zc
            ring.append(bm.verts.new((x, y, z)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n): bm.faces.new((r0[i], r0[(i + 1) % n], r1[(i + 1) % n], r1[i]))
    if cap:
        bm.faces.new(rings[0][::-1]); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return obj_from(bm, name, m)

def box(name, size, loc, m, bevel=0.02, rot=(0, 0, 0)):
    bm = bmesh.new(); bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.rotate(bm, matrix=Matrix.Rotation(rot[0], 3, 'X') @ Matrix.Rotation(rot[1], 3, 'Y') @ Matrix.Rotation(rot[2], 3, 'Z'), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    o = obj_from(bm, name, m); mods(o, bevel=bevel, seg=1, smooth=False); return o

def cyl(name, r1, r2, depth, loc, m, n=24, axis='Y', cap=True, bevel=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=n, radius1=r1, radius2=r2, depth=depth)
    if axis == 'Y': bmesh.ops.rotate(bm, matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    o = obj_from(bm, name, m); mods(o, bevel=bevel, seg=2, angle=35); return o

def torus(name, R, r, loc, m):
    bpy.ops.mesh.primitive_torus_add(major_radius=R, minor_radius=r, major_segments=32, minor_segments=8, location=loc, rotation=(math.pi / 2, 0, 0))
    o = bpy.context.active_object; o.name = name; o.data.materials.append(M[m]); parts.append(o)
    for p in o.data.polygons: p.use_smooth = True
    return o

# ---------------- fuselage ----------------
fus = loft('fuselage', [
    (-5.45, 1.5, 1.2, 0.05), (-4.6, 1.95, 1.4, 0.05), (-2.5, 2.25, 1.5, 0.05), (0.5, 2.3, 1.5, 0.05), (3.0, 2.05, 1.38, 0.0),
    (4.8, 1.55, 1.1, -0.08), (5.9, 0.9, 0.7, -0.15), (6.5, 0.32, 0.28, -0.2), (6.75, 0.06, 0.06, -0.22)], 'hull', n=28, expo=3.2)
mods(fus, bevel=0.03, sub=1, angle=60)
# dorsal spine
sp = loft('spine', [(-4.9, 0.9, 0.5, 0.86), (-3.0, 1.35, 0.7, 0.92), (1.0, 1.4, 0.75, 0.95), (2.0, 1.2, 0.55, 0.88), (2.4, 0.8, 0.25, 0.8)], 'panel', n=20, expo=4)
mods(sp, bevel=0.03, sub=1, angle=50)
# canopy (glass) + frame
bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=1, location=(0, 3.5, 0.72))
can = bpy.context.active_object; can.name = 'canopy'; can.scale = (0.56, 1.7, 0.5); can.data.materials.append(M['glass']); parts.append(can)
for p in can.data.polygons: p.use_smooth = True
box('canopyFrame', (0.06, 2.4, 0.06), (0, 3.4, 1.2), 'dark', 0.01)
for yy in (2.6, 3.6, 4.5): box('frameRib', (1.0, 0.07, 0.05), (0, yy, 1.08 - abs(yy - 3.5) * 0.12), 'dark', 0.01)
# chin sensor pod
cyl('chin', 0.32, 0.18, 2.6, (0, 4.2, -0.78), 'dark', n=16, bevel=0.02)
bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8, radius=0.2, location=(0, 5.5, -0.8))
ball = bpy.context.active_object; ball.data.materials.append(M['glass']); parts.append(ball)
# side intakes on fuselage
for s in (-1, 1):
    box('intake', (0.35, 1.6, 0.8), (s * 1.18, 1.0, 0.0), 'panel', 0.05)
    box('intakeIn', (0.2, 0.08, 0.6), (s * 1.24, 1.82, 0.0), 'dark', 0.0)
    box('stripe', (0.02, 3.2, 0.12), (s * 1.16, -1.5, 0.45), 'accent', 0.005)

# ---------------- nacelles ----------------
for s in (-1, 1):
    nx = s * 1.78
    nac = loft('nacelle', [(3.5, 1.55, 1.55, -0.15), (3.2, 1.9, 1.9, -0.15), (2.0, 2.0, 2.0, -0.15), (-3.0, 2.0, 2.0, -0.15), (-4.9, 1.95, 1.95, -0.15), (-5.3, 2.1, 2.1, -0.15)], 'hull', n=32, cap=False, expo=2.0)
    nac.location.x = nx; mods(nac, bevel=0.0, sub=1, angle=50)
    torus('intakeLip', 0.82, 0.12, (nx, 3.5, -0.15), 'panel')
    cyl('intakeCone', 0.5, 0.05, 0.9, (nx, 3.2, -0.15), 'dark', n=24)
    # nacelle rings / panel bands
    for yy in (-0.9, -3.4): torus('band', 1.0, 0.05, (nx, yy, -0.15), 'dark')
    box('nacTop', (1.1, 5.0, 0.22), (nx, -0.6, 0.86), 'panel', 0.04)
    for k in range(5): box('vent', (0.05, 0.25, 0.5), (nx + s * 1.0, -1.4 - k * 0.32, -0.15), 'dark', 0.01)
    # nozzle: flared shroud + petals + hot core
    cyl('nozzle', 1.02, 0.92, 1.1, (nx, -5.8, -0.15), 'nozzle', n=32, cap=False)
    for k in range(14):
        a = 2 * math.pi * k / 14
        p = box('petal', (0.36, 0.7, 0.05), (nx + math.cos(a) * 0.97, -6.1, -0.15 + math.sin(a) * 0.97), 'nozzle', 0.01, rot=(0, -a + math.pi / 2, 0))
        p.rotation_euler = (0, 0, 0)
    cyl('nozIn', 0.8, 0.8, 0.9, (nx, -5.6, -0.15), 'dark', n=32, cap=False)
    cyl('hotCore', 0.78, 0.78, 0.04, (nx, -5.3, -0.15), 'hot', n=32)
    cyl('turbine', 0.25, 0.1, 0.4, (nx, -5.15, -0.15), 'nozzle', n=16)
    # twin dorsal tail fins
    bm = bmesh.new()
    pts = [(0, -2.6, 0.9), (0, -5.0, 0.9), (0, -5.4, 2.3), (0, -4.6, 2.35)]
    vs = [bm.verts.new((nx + s * 0.1 + px, py, pz)) for px, py, pz in pts]; vs2 = [bm.verts.new((v.co.x - s * 0.18, v.co.y, v.co.z)) for v in vs]
    bm.faces.new(vs); bm.faces.new(vs2[::-1])
    for i in range(4): bm.faces.new((vs[i], vs2[i], vs2[(i + 1) % 4], vs[(i + 1) % 4]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    f = obj_from(bm, 'tailFin', 'hull'); f.rotation_euler = (0, s * -0.22, 0); mods(f, bevel=0.03, seg=2, smooth=False)

# ---------------- wings (lofted airfoil) ----------------
def airfoil(chord_front, chord_back, thick, x, ztop):
    # 10-point symmetric-ish profile from leading edge (front, +y) to trailing edge
    pts = []
    prof = [(0.0, 0.0), (0.04, 0.55), (0.15, 0.95), (0.35, 1.0), (0.6, 0.8), (0.85, 0.4), (1.0, 0.05)]
    L = chord_front - chord_back
    up = [(x, chord_front - t * L, ztop - thick * (1 - h) * 0.5) for t, h in prof]
    lo = [(x, chord_front - t * L, ztop - thick * 0.5 - thick * h * 0.5) for t, h in prof[::-1][1:-1]]
    return up + lo
for s in (-1, 1):
    root = airfoil(1.0, -3.6, 0.42, s * 2.3, 0.08)
    mid = airfoil(-0.6, -3.55, 0.3, s * 5.0, -0.12)
    tip = airfoil(-2.0, -3.5, 0.16, s * 7.65, -0.33)
    bm = bmesh.new(); R = [[bm.verts.new(p) for p in sec] for sec in (root, mid, tip)]
    n = len(root)
    for a, b in zip(R, R[1:]):
        for i in range(n):
            f = (a[i], a[(i + 1) % n], b[(i + 1) % n], b[i]); bm.faces.new(f if s > 0 else f[::-1])
    bm.faces.new(R[0] if s > 0 else R[0][::-1]); bm.faces.new(R[-1][::-1] if s > 0 else R[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    w = obj_from(bm, 'wing', 'hull'); mods(w, bevel=0.02, seg=2, angle=35)
    # panels / flaps / weapon pod / nav light
    box('flap', (2.8, 0.5, 0.06), (s * 4.6, -3.2, 0.0), 'panel', 0.01)
    box('panelA', (2.0, 1.1, 0.04), (s * 3.6, -1.5, 0.12), 'panel', 0.01)
    box('panelB', (1.2, 0.5, 0.04), (s * 5.5, -2.4, -0.04), 'dark', 0.01)
    cyl('pod', 0.22, 0.22, 2.6, (s * 4.4, -1.4, -0.42), 'dark', n=16, bevel=0.02)
    cyl('podTip', 0.22, 0.02, 0.6, (s * 4.4, 0.15, -0.42), 'panel', n=16)
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.12, location=(s * 7.7, -3.6, -0.3))
    nl = bpy.context.active_object; nl.data.materials.append(M['navG' if s > 0 else 'navR']); parts.append(nl)
    # ventral wingtip fin (hangs down)
    bm = bmesh.new()
    pts = [(-1.4, 0.9), (-3.9, 0.9), (-3.9, -2.2), (-1.9, -1.9)]
    vs = [bm.verts.new((s * 7.72, py, pz)) for py, pz in pts]; vs2 = [bm.verts.new((s * 7.48, py, pz)) for py, pz in pts]
    bm.faces.new(vs); bm.faces.new(vs2[::-1])
    for i in range(4): bm.faces.new((vs[i], vs2[i], vs2[(i + 1) % 4], vs[(i + 1) % 4]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    f = obj_from(bm, 'wingFin', 'panel'); mods(f, bevel=0.03, seg=2, smooth=False)

# ---------------- greebles ----------------
for i in range(40):
    w, h, l = 0.12 + random.random() * 0.4, 0.05 + random.random() * 0.12, 0.25 + random.random() * 1.2
    y = -4.5 + random.random() * 6.5
    if random.random() < 0.55: box('greeble', (w, l, h), ((random.random() - 0.5) * 1.0, y, 1.2 + h / 2), random.choice(['dark', 'panel']), 0.01)
    else:
        s = random.choice((-1, 1)); box('greeble', (h, l, w), (s * (1.15 + h / 2), y, (random.random() - 0.5) * 0.8), 'dark', 0.01)
for i in range(16):
    s = random.choice((-1, 1)); box('nacGreeble', (0.3 + random.random() * 0.4, 0.3 + random.random(), 0.1), (s * 1.78 + (random.random() - 0.5) * 0.6, -3 + random.random() * 4.5, 1.0), random.choice(['dark', 'panel']), 0.01)
cyl('antenna', 0.03, 0.01, 1.1, (0.3, -3.5, 1.7), 'dark', n=6, axis='Z')
box('sensorBlock', (0.9, 1.2, 0.3), (0, -4.2, 1.35), 'dark', 0.03)

# ---------------- apply, join, UV, AO bake ----------------
bpy.ops.object.select_all(action='DESELECT')
for o in parts:
    o.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.convert(target='MESH')
bpy.ops.object.join()
ship = bpy.context.active_object; ship.name = 'Gunship'
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='SELECT')
bpy.ops.mesh.remove_doubles(threshold=0.0005)
bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.004)
bpy.ops.object.mode_set(mode='OBJECT')
print('TRIS', sum(len(p.vertices) - 2 for p in ship.data.polygons))

RES = int(os.environ.get('AORES', '1024'))
img = bpy.data.images.new('ship_ao', RES, RES)
for m in ship.data.materials:
    nt = m.node_tree; n = nt.nodes.new('ShaderNodeTexImage'); n.image = img; nt.nodes.active = n
scn.render.engine = 'CYCLES'; scn.cycles.device = 'CPU'; scn.cycles.samples = int(os.environ.get('AOSAMP', '48'))
scn.render.bake.margin = 6
bpy.ops.object.bake(type='AO')
img.filepath_raw = OUT + '/ship_ao.png'; img.file_format = 'PNG'; img.save()
for m in ship.data.materials:
    for n in list(m.node_tree.nodes):
        if n.type == 'TEX_IMAGE': m.node_tree.nodes.remove(n)

bpy.ops.export_scene.gltf(filepath=OUT + '/gunship.glb', export_format='GLB', use_selection=True, export_draco_mesh_compression_enable=True,
                          export_draco_mesh_compression_level=7, export_apply=True, export_texcoords=True, export_normals=True, export_materials='EXPORT')
print('EXPORTED', os.path.getsize(OUT + '/gunship.glb'))
