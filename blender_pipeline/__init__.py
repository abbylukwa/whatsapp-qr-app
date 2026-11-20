"""
blender_pipeline — AI-orchestrated educational 3D film factory.

Generates hyper-detailed, physics-aware Blender .bpy scripts (one per
object, object-by-object, exactly like a studio artist would work:
model → materials → textures → physics → pose), then assembles the
final cinematic (scenes, lighting rigs, camera animation, narration
timing) and an executable render plan.

DESIGN PRINCIPLES (the owner's brief):
  * NOTHING is hardcoded top-down. The pipeline is a SKELETON: an AI
    "art director" decides WHAT to build (object list, proportions,
    colors, hair density, actions, camera style, narration) as JSON
    specs. Deterministic emitters translate each spec into rigorous
    bpy code. No AI key? A curated knowledge + heuristics brain
    (knowledge.py) fills the specs so the pipeline still works.
  * Runs WITHOUT Blender on the server: this package only writes
    .bpy files + progress state. Blender executes them wherever the
    user has it:  blender --background --python file.bpy
  * Resumable: every stage/object/scene has a status in
    progress.json; interrupted runs continue where they stopped.
  * Budget-aware: counts API calls, stops calling the AI past the
    budget and finishes with the local brain.

Usage:
  python -m blender_pipeline all --topic "The San people of the Kalahari" --grade 10
  python -m blender_pipeline plan    --workdir work/san
  python -m blender_pipeline objects --workdir work/san
  python -m blender_pipeline assemble --workdir work/san
  python -m blender_pipeline status  --workdir work/san
"""

__version__ = "1.0.0"
