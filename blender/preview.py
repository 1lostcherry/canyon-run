import bpy, math, sys
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath='/workspace/canyon-flight/assets/gunship.glb')
scn = bpy.context.scene
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam')); scn.collection.objects.link(cam); scn.camera = cam
import mathutils
for i, (pos, name) in enumerate([((14, 13, 9), 'a'), ((-12, -16, 6), 'b'), ((0, 2, 24), 'c')]):
    cam.location = pos
    d = mathutils.Vector((0, 0, 0)) - cam.location; cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    cam.data.lens = 50
    scn.render.engine = 'CYCLES'; scn.cycles.samples = 24; scn.cycles.use_denoising = False
    if not scn.world: scn.world = bpy.data.worlds.new('w')
    scn.world.use_nodes = True; scn.world.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.6, 0.7, 1); scn.world.node_tree.nodes['Background'].inputs[1].default_value = 1.2
    if 'sun' not in bpy.data.objects:
        sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN')); sun.data.energy = 4; sun.rotation_euler = (0.7, 0.3, 0.8); scn.collection.objects.link(sun)
    scn.render.resolution_x = 640; scn.render.resolution_y = 420
    scn.render.filepath = f'/tmp/ship_prev_{name}.png'; bpy.ops.render.render(write_still=True)
