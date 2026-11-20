"""Emitter dispatcher: object kind -> code generator."""
from . import terrain, spear, human
from . import objects_misc as misc

# kind -> callable(spec) -> bpy source string
REGISTRY = {
    "terrain": terrain.emit,
    "spear":   spear.emit,
    "bow":     spear.emit_bow,
    "human":   human.emit,
    "fire":    misc.emit_fire,
    "hut":     misc.emit_hut,
    "animal":  misc.emit_animal,
    "props":   misc.emit_props,
    # friendly aliases
    "weapon":  spear.emit,
    "tool":    misc.emit_props,
    "artifact": misc.emit_props,
    "landscape": terrain.emit,
    "person":  human.emit,
    "figure":  human.emit,
    "quadraped": misc.emit_animal,
    "antelope": misc.emit_animal,
    "campfire": misc.emit_fire,
    "shelter":  misc.emit_hut,
}

# filename prefix per kind (keeps the bpy folder ordered like a shot list)
PREFIX = {
    "terrain": "10", "landscape": "10",
    "spear": "20", "bow": "21", "weapon": "20",
    "human": "30", "person": "30", "figure": "30",
    "fire": "40", "campfire": "40",
    "hut": "41", "shelter": "41",
    "animal": "42", "antelope": "42",
    "props": "43", "tool": "43", "artifact": "43",
}


def emit(spec):
    """Validate + dispatch. Raises ValueError with a clear message for
    unknown kinds so the planner can be corrected instead of failing
    silently inside Blender."""
    kind = str(spec.get("kind", "props")).lower()
    fn = REGISTRY.get(kind)
    if fn is None:
        raise ValueError(
            f"unknown object kind '{kind}' (known: {', '.join(sorted(REGISTRY))})")
    name = "".join(c if c.isalnum() else "_" for c in spec.get("name", "object"))
    code = fn({**spec, "name": name})
    return PREFIX.get(kind, "43"), name, code
