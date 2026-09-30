# Blender animation sequences for the Zuse × boxd launch film.
# Usage: blender -b -P anim.py -- <shot> <outdir> [--frames a-b] [--res N] [--engine EEVEE|CYCLES]
#   shots: land | hibernate | wake | fork | size-small | size-standard | size-large
# Output: transparent PNG sequence <outdir>/0001.png … at 30fps (stills for size-*).
# Every sequence that follows a 2D shape opens on a straight-on view of the black notched cube,
# which reads as the flat boxd mark — so the 2D → 3D handoff is a shape change, not a cut.
import bpy, sys, math
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:]
shot, outdir = argv[0], argv[1]
opts = {argv[i]: argv[i + 1] for i in range(2, len(argv) - 1, 2)}
RES = int(opts.get("--res", 1080))
ENGINE = opts.get("--engine", "CYCLES")

FPS = 30
BEAT = FPS // 2  # 120 BPM
LIME = (0.50, 0.78, 0.02)
ROSE = (0.75, 0.10, 0.15)
INK = (0.004, 0.005, 0.008)       # boxd-ink #0A0C12, linear
GREY = (0.42, 0.43, 0.42)
CANVAS = (0.905, 0.88, 0.83)      # linear of #F4F1EB

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.render.resolution_x = scene.render.resolution_y = RES
scene.render.film_transparent = True
scene.render.image_settings.file_format = "PNG"
scene.render.image_settings.color_mode = "RGBA"
scene.view_settings.view_transform = "AgX"
scene.view_settings.look = "AgX - Medium High Contrast"
if ENGINE == "CYCLES":
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = int(opts.get("--samples", 28))
    scene.cycles.use_denoising = True
else:
    scene.render.engine = "BLENDER_EEVEE"
    ee = scene.eevee
    ee.taa_render_samples = 48
    if hasattr(ee, "use_raytracing"):
        ee.use_raytracing = True
    if hasattr(ee, "ray_tracing_options"):
        ee.ray_tracing_options.resolution_scale = "1"
    if hasattr(ee, "use_shadows"):
        ee.use_shadows = True

world = bpy.data.worlds.new("w"); scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (*CANVAS, 1)
bg.inputs[1].default_value = 0.9


def ease(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def spring(t, zeta=0.55, w=14.0):
    """Closed-form underdamped step response (0→1), t in seconds."""
    if t <= 0:
        return 0.0
    wd = w * math.sqrt(1 - zeta * zeta)
    return 1 - math.exp(-zeta * w * t) * (math.cos(wd * t) + zeta * w / wd * math.sin(wd * t))


def key(sock_or_obj, path, frame, value):
    if isinstance(sock_or_obj, bpy.types.NodeSocket):
        sock_or_obj.default_value = value
        sock_or_obj.keyframe_insert("default_value", frame=frame)
    else:
        setattr(sock_or_obj, path, value)
        sock_or_obj.keyframe_insert(path, frame=frame)


def principled(name, color, rough=0.3, emit=0.0, coat=0.0, transmission=0.0):
    m = bpy.data.materials.new(name); m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Coat Weight"].default_value = coat
    b.inputs["Transmission Weight"].default_value = transmission
    b.inputs["Emission Color"].default_value = (*color, 1)
    b.inputs["Emission Strength"].default_value = emit
    return m, b


def shell_material(name):
    """Glass ↔ opaque boxd-ink, blended by a keyed Mix factor (0 = ink, 1 = glass)."""
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree; nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    ink = nt.nodes.new("ShaderNodeBsdfPrincipled")
    ink.inputs["Base Color"].default_value = (*INK, 1)
    ink.inputs["Roughness"].default_value = 0.35
    ink.inputs["Coat Weight"].default_value = 0.4
    glass = nt.nodes.new("ShaderNodeBsdfPrincipled")
    glass.inputs["Base Color"].default_value = (0.98, 0.99, 1.0, 1)
    glass.inputs["Roughness"].default_value = 0.02
    glass.inputs["Transmission Weight"].default_value = 1.0
    glass.inputs["IOR"].default_value = 1.45
    nt.links.new(ink.outputs[0], mix.inputs[1])
    nt.links.new(glass.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    if scene.render.engine != "CYCLES":
        m.surface_render_method = "DITHERED"
        if hasattr(m, "use_raytrace_refraction"):
            m.use_raytrace_refraction = True
        if hasattr(m, "use_transparency_overlap"):
            m.use_transparency_overlap = True
    return m, mix.inputs[0], glass.inputs["Roughness"]


def rounded_box(name, size, loc, material, bevel=0.08, notch=0.0, parent=None):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.object; o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(scale=True)
    if notch:
        w, d, h = size
        bpy.ops.mesh.primitive_cube_add(size=1, location=(loc[0] - w / 2, loc[1], loc[2] - h / 2))
        cutter = bpy.context.object
        cutter.scale = (notch * 2, d * 1.2, notch * 2)
        cutter.hide_render = True; cutter.hide_viewport = True
        b = o.modifiers.new("notch", "BOOLEAN"); b.object = cutter; b.operation = "DIFFERENCE"; b.solver = "EXACT"
        if parent:
            cutter.parent = parent
    bv = o.modifiers.new("bevel", "BEVEL"); bv.width = bevel; bv.segments = 8; bv.limit_method = "ANGLE"
    o.data.materials.append(material)
    bpy.ops.object.shade_smooth()
    if parent:
        o.parent = parent
    return o


class Machine:
    """Glass boxd machine: notched shell + 26 process cores (lime = agents, rose = boxd runtime)."""

    def __init__(self, tag, x=0.0):
        bpy.ops.object.empty_add(location=(x, 0, 0)); self.root = bpy.context.object
        self.shell_mat, self.shell_mix, self.shell_rough = shell_material(f"shell-{tag}")
        rounded_box(f"shell-{tag}", (1.6, 1.6, 1.6), (x, 0, 0.8), self.shell_mat, bevel=0.12, notch=0.3, parent=self.root)
        self.cores = []
        idx = 0
        for i in range(3):
            for j in range(3):
                for k in range(3):
                    if i == 0 and k == 0 and j == 2:
                        continue  # the notch corner stays clear
                    kind = "lime" if (i + j + k) % 3 == 0 else "rose" if (i + 2 * j + k) % 5 == 0 else "ink"
                    col = LIME if kind == "lime" else ROSE if kind == "rose" else (0.02, 0.02, 0.022)
                    m, b = principled(f"core-{tag}-{idx}", col, rough=0.3, coat=0.4)
                    p = (x + (i - 1) * 0.42, (j - 1) * 0.42, 0.8 + (k - 1) * 0.42)
                    rounded_box(f"core-{tag}-{idx}", (0.24, 0.24, 0.24), p, m, bevel=0.05, parent=self.root)
                    self.cores.append({"kind": kind, "bsdf": b, "col": col, "order": (idx * 7) % 26})
                    idx += 1

    def shell(self, frame, mix=None, rough=None):
        if mix is not None:
            key(self.shell_mix, None, frame, mix)
        if rough is not None:
            key(self.shell_rough, None, frame, rough)

    def core(self, c, frame, lit):
        """lit in 0..1: 0 = frozen grey (or ink for ink cores), 1 = live colour."""
        if c["kind"] == "ink":
            return
        col = tuple(GREY[n] + (c["col"][n] - GREY[n]) * lit for n in range(3))
        key(c["bsdf"].inputs["Base Color"], None, frame, (*col, 1))
        key(c["bsdf"].inputs["Emission Strength"], None, frame, 0.35 * lit)

    def live_cores(self):
        return [c for c in self.cores if c["kind"] != "ink"]

    def flicker(self, f0, f1):
        """'Processes working': each live core breathes on its own deterministic phase."""
        for c in self.live_cores():
            for f in range(f0, f1 + 1, 5):
                phase = c["order"] * 0.77
                v = 0.82 + 0.18 * math.sin(f / FPS * 5.2 + phase)
                key(c["bsdf"].inputs["Emission Strength"], None, f, 0.35 * v)


def floor():
    bpy.ops.mesh.primitive_plane_add(size=60)
    bpy.context.object.is_shadow_catcher = True


def lights():
    for loc, energy, size in (((-3, -4, 6), 900, 5), ((4, 2, 3), 300, 3)):
        bpy.ops.object.light_add(type="AREA", location=loc)
        l = bpy.context.object; l.data.energy = energy; l.data.size = size
        l.rotation_euler = (Vector((0, 0, 0.5)) - l.location).to_track_quat("-Z", "Y").to_euler()


TARGET = Vector((0, 0, 0.8))
DIST = 7.0
THREE_Q = (-58.0, 27.0)   # azimuth, elevation (deg) — the hero 3/4 view
FRONT = (-90.0, 0.0)      # straight-on: the cube face reads as the flat boxd mark


def camera():
    bpy.ops.object.camera_add()
    c = bpy.context.object; c.data.lens = 62
    scene.camera = c
    return c


def place_cam(cam, frame, az, el, target=TARGET):
    a, e = math.radians(az), math.radians(el)
    loc = target + Vector((DIST * math.cos(e) * math.cos(a), DIST * math.cos(e) * math.sin(a), DIST * math.sin(e)))
    cam.location = loc
    cam.rotation_euler = (target - loc).to_track_quat("-Z", "Y").to_euler()
    cam.keyframe_insert("location", frame=frame)
    cam.keyframe_insert("rotation_euler", frame=frame)


def intro(cam, m, f0, frames, cores_lit):
    """Front-on ink square → 3/4 glass machine over `frames` frames."""
    for n in range(frames + 1):
        t = ease(n / frames)
        az = FRONT[0] + (THREE_Q[0] - FRONT[0]) * t
        el = FRONT[1] + (THREE_Q[1] - FRONT[1]) * t
        place_cam(cam, f0 + n, az, el)
    m.shell(f0, mix=0.0)
    m.shell(f0 + int(frames * 0.25), mix=0.0)
    m.shell(f0 + frames, mix=1.0)
    for c in m.live_cores():
        m.core(c, f0, cores_lit)


floor(); lights()
cam = camera()

if shot.startswith("size-"):
    # Solid product-style machines for the size picker (one still each).
    s = {"size-small": 0.7, "size-standard": 1.0, "size-large": 1.35}[shot]
    white, _ = principled("shell", (0.93, 0.93, 0.92), rough=0.28, coat=0.4)
    vent, _ = principled("vent", (0.08, 0.08, 0.08), rough=0.6)
    led, _ = principled("led", LIME, rough=0.2, emit=1.2)
    w, d, h = 1.0 * s, 1.0 * s, 0.62 * s
    rounded_box("body", (w, d, h), (0, 0, h / 2), white, bevel=0.09 * s, notch=0.16 * s)
    for i in range(5):
        rounded_box("vent", (w * 0.62, 0.02, 0.018 * s), (0, -d / 2 - 0.002, h * (0.3 + i * 0.1)), vent, bevel=0.008 * s)
    rounded_box("led", (w * 0.14, 0.02, 0.02 * s), (w * 0.3, -d / 2 - 0.004, h * 0.16), led, bevel=0.008 * s)
    # Same camera for all three so relative size reads true.
    place_cam(cam, 1, -64.0, 24.0, target=Vector((0, 0, 0.42)))
    cam.data.lens = 70
    scene.frame_start = scene.frame_end = 1
    scene.render.filepath = f"{outdir}/{shot}.png"
    bpy.ops.render.render(write_still=True)
    sys.exit(0)

m = Machine("a")

if shot == "land":
    # 3.5s: 0.6s intro (cores dark) then one core group lights per beat on beats 2..6.
    total = int(3.5 * FPS)
    intro(cam, m, 1, 18, 0.0)
    live = sorted(m.live_cores(), key=lambda c: c["order"])
    groups = [live[g::5] for g in range(5)]
    for g, grp in enumerate(groups):
        fb = 1 + (g + 2) * BEAT
        for c in grp:
            m.core(c, fb - 1, 0.0)
            for n in range(0, 9, 2):
                m.core(c, fb + n, spring(n / FPS, zeta=0.45, w=22))
    place_cam(cam, total, *THREE_Q)
    m.flicker(int(2.6 * FPS), total)
elif shot == "hibernate":
    # 5.0s: intro with cores already live (0.6s), live until 1.2s, then frost creeps and cores freeze one by one.
    total = int(5.0 * FPS)
    intro(cam, m, 1, 18, 1.0)
    place_cam(cam, total, *THREE_Q)
    m.flicker(19, int(1.2 * FPS))
    m.shell(int(1.2 * FPS), rough=0.02)
    for n in range(0, 101, 5):  # ease-in frost over 3.4s
        f = int(1.2 * FPS) + n
        m.shell(f, rough=0.02 + 0.40 * ease(n / 100))
    live = sorted(m.live_cores(), key=lambda c: c["order"])
    for i, c in enumerate(live):
        f = int(1.4 * FPS) + int(i * (3.0 * FPS) / len(live))
        m.core(c, f, 1.0)
        m.core(c, f + 8, 0.0)
elif shot == "wake":
    # 2.0s: frozen → glass snaps clear in 6 frames at 0.1s → cores relight fast, staggered.
    total = int(2.0 * FPS)
    place_cam(cam, 1, *THREE_Q); place_cam(cam, total, *THREE_Q)
    m.shell(1, mix=1.0, rough=0.42)
    m.shell(4, rough=0.42)
    m.shell(10, rough=0.02)
    for c in m.live_cores():
        m.core(c, 1, 0.0)
    live = sorted(m.live_cores(), key=lambda c: c["order"])
    for i, c in enumerate(live):
        f = 9 + int(i * 18 / len(live))
        m.core(c, f, 0.0)
        for n in range(0, 9, 2):
            m.core(c, f + 1 + n, spring(n / FPS, zeta=0.45, w=26))
    m.flicker(36, total)
elif shot == "fork":
    # 4.0s, rendered 2:1 (same vertical framing as the square shots, wider horizontally).
    # An identical copy springs out to the right; the camera tracks to it while the original
    # drifts off-frame left, so the last frame's centre square == the first frame's (removable beat).
    total = int(4.0 * FPS)
    SHIFT = 2.3
    scene.render.resolution_x = RES * 2
    cam.data.sensor_fit = "VERTICAL"
    cam.data.sensor_height = 36.0
    b = Machine("b")
    m.shell(1, mix=1.0); b.shell(1, mix=1.0)
    m.flicker(1, total); b.flicker(1, total)
    split0 = int(0.5 * FPS)
    for n in range(0, total + 1):
        t = (n - split0) / FPS
        b.root.location.x = SHIFT * spring(t, zeta=0.62, w=11) if n >= split0 else 0.0
        b.root.keyframe_insert("location", frame=1 + n)
        d = ease((n / FPS - 1.8) / 1.6)
        m.root.location.x = -3.6 * d
        m.root.keyframe_insert("location", frame=1 + n)
    for n in range(0, total + 1, 2):
        t = ease((n / FPS - 1.6) / 1.6)
        place_cam(cam, 1 + n, *THREE_Q, target=TARGET + Vector((SHIFT * t, 0, 0)))
    place_cam(cam, total, *THREE_Q, target=TARGET + Vector((SHIFT, 0, 0)))
else:
    raise SystemExit(f"unknown shot {shot}")

scene.frame_start = 1
scene.frame_end = total
fr = opts.get("--frames")
if fr:
    a, z = fr.split("-")
    scene.frame_start, scene.frame_end = int(a), int(z)
scene.render.filepath = f"{outdir}/"
bpy.ops.render.render(animation=True)
