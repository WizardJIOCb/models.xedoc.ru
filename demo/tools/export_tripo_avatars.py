"""Convert Crimson Wars rigged FBX characters to embedded-texture GLBs.

Run with Blender in background mode:

    blender --background --factory-startup --python export_tripo_avatars.py
"""

from pathlib import Path

import bpy


TRIPO_ROOT = Path(r"C:\Projects\crimson-wars-native\Stuff\Tripo3d")
OUTPUT_ROOT = Path(__file__).resolve().parents[1] / "assets" / "avatars"
HEROES = ("scout", "raider", "shadow", "cyber", "medis")
MONSTERS = (
    "normal",
    "runner",
    "ranged",
    "sniper",
    "medic",
    "splitter",
    "exploder",
    "charger",
    "brute",
    "shield",
    "boss",
    "boss_hellmart",
    "boss_chief_surgeon",
    "boss_road_titan",
    "boss_reactor_apostle",
)


def source_path(avatar_id: str) -> Path:
    collection = "RiggedHeroes" if avatar_id in HEROES else "RiggedModels"
    folder = TRIPO_ROOT / collection / avatar_id
    preferred = folder / f"SK_{avatar_id}_walk_death_animfix.fbx"
    if preferred.is_file():
        return preferred
    return folder / f"SK_{avatar_id}_walk_death.fbx"


def clean_skin_weights(meshes) -> None:
    """Match the four-influence limit used by Three.js linear skinning."""
    for obj in meshes:
        if not obj.vertex_groups:
            raise RuntimeError(f"{obj.name}: mesh has no skin vertex groups")
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.vertex_group_clean(
            group_select_mode="ALL", limit=0.001, keep_single=True
        )
        bpy.ops.object.vertex_group_limit_total(group_select_mode="ALL", limit=4)
        bpy.ops.object.vertex_group_normalize_all(
            group_select_mode="ALL", lock_active=False
        )


def export_avatar(avatar_id: str) -> None:
    source = source_path(avatar_id)
    destination = OUTPUT_ROOT / f"{avatar_id}.glb"
    if not source.is_file():
        raise FileNotFoundError(source)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source), use_anim=False)

    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(armatures) != 1 or len(meshes) != 1:
        raise RuntimeError(
            f"{avatar_id}: expected one armature and one mesh, got "
            f"{len(armatures)} armatures and {len(meshes)} meshes"
        )

    armature = armatures[0]
    armature.data.pose_position = "REST"
    armature.animation_data_clear()
    for obj in meshes:
        obj.animation_data_clear()

    clean_skin_weights(meshes)

    bpy.ops.object.select_all(action="DESELECT")
    armature.select_set(True)
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = armature

    OUTPUT_ROOT.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(destination),
        export_format="GLB",
        use_selection=True,
        export_animations=False,
        export_skins=True,
        export_materials="EXPORT",
        export_yup=True,
        export_apply=False,
    )
    print(
        f"EXPORTED {avatar_id}: {destination} "
        f"({destination.stat().st_size / 1024:.1f} KiB)"
    )


for avatar in HEROES + MONSTERS:
    try:
        export_avatar(avatar)
    except Exception as exc:
        print(f"SKIPPED {avatar}: {exc}")
