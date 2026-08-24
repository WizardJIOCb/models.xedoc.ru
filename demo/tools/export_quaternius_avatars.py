"""Export selected CC0 Quaternius characters for the Kimodo web preview.

Run with Blender in background mode:

    blender --background --factory-startup --python export_quaternius_avatars.py
"""

from pathlib import Path

import bpy


WORK_ROOT = Path(r"C:\Projects\Text2Motion\work\external-characters")
RPG_ROOT = WORK_ROOT / "quaternius-rpg" / "FBX"
ULTIMATE_ROOT = WORK_ROOT / "quaternius-selected"
OUTPUT_ROOT = Path(__file__).resolve().parents[1] / "assets" / "avatars"
RPG_TEXTURES = WORK_ROOT / "quaternius-rpg" / "Textures"

AVATARS = {
    "sun_cleric": RPG_ROOT / "Cleric.fbx",
    "stone_monk": RPG_ROOT / "Monk.fbx",
    "wild_ranger": RPG_ROOT / "Ranger.fbx",
    "dusk_rogue": RPG_ROOT / "Rogue.fbx",
    "iron_warrior": RPG_ROOT / "Warrior.fbx",
    "arcane_sage": RPG_ROOT / "Wizard.fbx",
    "golden_sentinel": ULTIMATE_ROOT / "Knight_Golden_Male.fbx",
    "hedge_witch": ULTIMATE_ROOT / "Witch.fbx",
    "plaguebound": ULTIMATE_ROOT / "Zombie_Male.fbx",
}

TEXTURE_SETS = {
    "sun_cleric": ("Cleric_Texture.png", "Cleric_Staff_Texture.png"),
    "stone_monk": ("Monk_Texture.png", None),
    "wild_ranger": ("Ranger_Texture.png", "Ranger_Bow_Texture.png"),
    "dusk_rogue": ("Rogue_Texture.png", "Rogue_Dagger_Texture.png"),
    "iron_warrior": ("Warrior_Texture.png", "Warrior_Sword_Texture.png"),
    "arcane_sage": ("Wizard_Texture.png", "Wizard_Staff_Texture.png"),
}

PROP_NAME_PARTS = ("staff", "bow", "dagger", "sword")

BONE_RENAMES = {
    "Root": "root",
    "Bone": "root",
    "Hips": "pelvis",
    "Abdomen": "spine_01",
    "Torso": "spine_02",
    "Neck": "neck_01",
    "Head": "head",
    "Shoulder.L": "clavicle_l",
    "UpperArm.L": "upperarm_l",
    "LowerArm.L": "lowerarm_l",
    "Fist.L": "hand_l",
    "Shoulder.R": "clavicle_r",
    "UpperArm.R": "upperarm_r",
    "LowerArm.R": "lowerarm_r",
    "Fist.R": "hand_r",
    "UpperLeg.L": "thigh_l",
    "LowerLeg.L": "calf_l",
    "Foot.L": "foot_l",
    "UpperLeg.R": "thigh_r",
    "LowerLeg.R": "calf_r",
    "Foot.R": "foot_r",
}

REQUIRED_BONES = set(BONE_RENAMES.values()) - {"root"}


def clean_skin_weights(meshes: list[bpy.types.Object]) -> None:
    """Normalize skinned meshes to the four influences supported by Three.js."""
    for obj in meshes:
        if not obj.vertex_groups:
            continue
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


def normalize_legacy_materials() -> None:
    """Old Quaternius FBXs store opaque materials with a zero alpha value."""
    for material in bpy.data.materials:
        material.diffuse_color[3] = 1.0
        if not material.use_nodes:
            continue
        for node in material.node_tree.nodes:
            if node.type != "BSDF_PRINCIPLED":
                continue
            alpha = node.inputs.get("Alpha")
            if alpha:
                for link in list(alpha.links):
                    material.node_tree.links.remove(link)
                alpha.default_value = 1.0


def apply_rpg_textures(avatar_id: str, meshes: list[bpy.types.Object]) -> None:
    texture_set = TEXTURE_SETS.get(avatar_id)
    if not texture_set:
        return
    body_name, prop_name = texture_set
    body_path = RPG_TEXTURES / body_name
    prop_path = RPG_TEXTURES / prop_name if prop_name else None
    if not body_path.is_file() or (prop_path and not prop_path.is_file()):
        raise FileNotFoundError(f"Missing texture set for {avatar_id}")

    loaded: dict[Path, bpy.types.Image] = {}
    for mesh in meshes:
        lower_name = mesh.name.lower()
        is_prop = prop_path and any(part in lower_name for part in PROP_NAME_PARTS)
        image_path = prop_path if is_prop else body_path
        image = loaded.get(image_path)
        if image is None:
            image = bpy.data.images.load(str(image_path), check_existing=True)
            loaded[image_path] = image

        for material in mesh.data.materials:
            if material is None:
                continue
            material.use_nodes = True
            nodes = material.node_tree.nodes
            principled = next(
                (node for node in nodes if node.type == "BSDF_PRINCIPLED"), None
            )
            if principled is None:
                continue
            texture = nodes.new("ShaderNodeTexImage")
            texture.name = f"{avatar_id}_base_color"
            texture.label = image_path.name
            texture.image = image
            texture.interpolation = "Linear"
            material.node_tree.links.new(
                texture.outputs["Color"], principled.inputs["Base Color"]
            )
            principled.inputs["Roughness"].default_value = 0.72


def rename_rig(armature: bpy.types.Object, meshes: list[bpy.types.Object]) -> None:
    original_names = {bone.name for bone in armature.data.bones}
    missing = [
        name
        for name, target in BONE_RENAMES.items()
        if target != "root" and name not in original_names
    ]
    if not ({"Root", "Bone"} & original_names):
        missing.append("Root/Bone")
    if missing:
        raise RuntimeError(f"{armature.name}: missing source bones: {missing}")

    for old_name, new_name in BONE_RENAMES.items():
        if old_name not in armature.data.bones:
            continue
        armature.data.bones[old_name].name = new_name
        for mesh in meshes:
            group = mesh.vertex_groups.get(old_name)
            if group:
                group.name = new_name

    renamed = {bone.name for bone in armature.data.bones}
    still_missing = sorted(REQUIRED_BONES - renamed)
    if still_missing:
        raise RuntimeError(f"{armature.name}: missing Kimodo bones: {still_missing}")


def export_avatar(avatar_id: str, source: Path) -> None:
    destination = OUTPUT_ROOT / f"{avatar_id}.glb"
    if not source.is_file():
        raise FileNotFoundError(source)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(source), use_anim=False)

    armatures = [obj for obj in bpy.context.scene.objects if obj.type == "ARMATURE"]
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if len(armatures) != 1 or not meshes:
        raise RuntimeError(
            f"{avatar_id}: expected one armature and at least one mesh, got "
            f"{len(armatures)} armatures and {len(meshes)} meshes"
        )

    armature = armatures[0]
    armature.data.pose_position = "REST"
    armature.animation_data_clear()
    for pose_bone in armature.pose.bones:
        for constraint in list(pose_bone.constraints):
            pose_bone.constraints.remove(constraint)
    for obj in meshes:
        obj.animation_data_clear()

    rename_rig(armature, meshes)
    clean_skin_weights(meshes)
    normalize_legacy_materials()
    apply_rpg_textures(avatar_id, meshes)

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
        f"({destination.stat().st_size / 1024:.1f} KiB, {len(meshes)} meshes)"
    )


for avatar, path in AVATARS.items():
    export_avatar(avatar, path)
