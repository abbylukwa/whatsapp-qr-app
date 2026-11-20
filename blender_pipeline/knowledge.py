"""Curated knowledge base + local heuristics brain.

This is the ZERO-API fallback art director. It carries verified
mini-dossiers (era, materials, environment, actions) for common
syllabus topics — the San people dossier is deep enough to produce a
full accurate film — plus generic template dossiers for anything
else. The AI, when available, receives these as grounding context and
can override any field; when absent, these values stand alone.
"""

# ── DOSSIERS ────────────────────────────────────────────────────
DOSSIERS = {
    "san": {
        "aliases": ["san", "khoisan", "bushmen", "kalahari", "first people",
                    "hunter-gatherers", "basarwa", "!kung", "ju/'hoansi"],
        "era": "Late Stone Age to present (~20,000 BP - today)",
        "place": "Kalahari Desert, southern Africa (Botswana, Namibia, South Africa)",
        "environment": {
            "terrain": "red-orange sand dunes, dry golden grasses, acacia trees, dry riverbeds",
            "sky": "dusty warm blue, brilliant sun, cold clear nights",
            "palette": ["#c96f2e", "#d9a05b", "#8a5a2b", "#b5a642", "#7a9a5b", "#e8d8b0"],
            "time_of_day": "golden hour for hunts, blue dawn for gathering, fire-lit night for stories"
        },
        "objects": [
            {"kind": "spear", "name": "hunting_spear", "notes":
                "light hardwood shaft ~1.8m, fire-hardened tip, small iron/stone blade "
                "bound with sinew, used to hunt eland and antelope"},
            {"kind": "bow", "name": "hunting_bow", "notes":
                "recurved wooden bow ~1.5m with sinew string; arrows with poisoned "
                "tips (larvae toxin), feather fletching"},
            {"kind": "hut", "name": "grass_hut", "notes":
                "dome-shaped windbreak hut: bent sapling frame, thatched grass, "
                "low entrance facing away from wind"},
            {"kind": "fire", "name": "campfire", "notes":
                "fire made by fire-sticks friction; central to cooking, warmth, storytelling"},
            {"kind": "animal", "name": "eland", "notes":
                "eland antelope (largest antelope, spiral horns, tan coat) — "
                "the sacred animal in San rock art and ritual"},
            {"kind": "human", "name": "san_hunter_male", "notes":
                "adult hunter: small sturdy build (~155cm), dark copper-brown skin, "
                "peppercorn afro-textured hair, hide loincloth + kaross cloak, "
                "carrying bow, quiver and digging stick"},
            {"kind": "human", "name": "san_gatherer_female", "notes":
                "adult gatherer: hide apron, beaded necklace (ostrich eggshell beads), "
                "carrying digging stick and leather bag with roots and berries"},
            {"kind": "human", "name": "san_child", "notes":
                "child (~9yr, 120cm): playing with a small toy bow near the hut"},
            {"kind": "props", "name": "rock_art_panel", "notes":
                "granite boulder with ochre rock paintings: human figures, eland, "
                "handprints — painted with animal fat and hematite ochre"},
            {"kind": "props", "name": "ostrich_egg_flasks", "notes":
                "ostrich eggshells recycled as water flasks, stoppered with grass, "
                "beaded nets around them"},
        ],
        "human_details": {
            "skin_tone": [0.39, 0.21, 0.12],
            "skin_sss": 0.14,
            "hair": "peppercorn coils, sparse-to-medium density, high hairline",
            "hair_color": [0.04, 0.03, 0.025],
            "eyes": "dark brown iris, epicanthic-like fold, wide cheekbones",
            "clothing_male": "soft tan hide loincloth; kaross (antelope hide cloak) at night",
            "clothing_female": "fringed hide apron front and back, ostrich-eggshell bead headband",
            "jewelry": "ostrich eggshell bead necklace, arm rings of twisted gut",
            "body_paint": "red ochre streaks on cheeks for ceremony"
        },
        "scenes_template": [
            {"name": "opening_dawn",   "desc": "Aerial drift over red dunes at dawn; smoke from a distant camp", "mood": "cool dawn, soft haze"},
            {"name": "the_camp",       "desc": "Morning at the camp: fire embers, hut, children playing, tools laid out", "mood": "warm morning"},
            {"name": "making_tools",   "desc": "Close-up, hands crafting the spear: shaft straightened in fire, blade bound with sinew", "mood": "intimate, shallow DOF"},
            {"name": "the_hunt",       "desc": "Tracking across the dunes; spotting the eland; the stalk and the spear throw", "mood": "tense, golden hour"},
            {"name": "gathering",      "desc": "Women digging roots, gathering berries, filling ostrich-egg flasks", "mood": "bright midday canopy"},
            {"name": "firelight",      "desc": "Night: campfire, storytelling, trance dance silhouettes against the stars", "mood": "fire glow, deep blue night"},
            {"name": "rock_art",       "desc": "Dawn again: slow pan across the painted rock panel — the memory made permanent", "mood": "reverent, soft"}
        ]
    },
    "great_zimbabwe": {
        "aliases": ["great zimbabwe", "zimbabwe ruins", "shona civilization"],
        "era": "c. 1100-1450 CE",
        "place": "Great Zimbabwe, south-eastern Zimbabwe",
        "environment": {
            "terrain": "granite kopjes, acacia woodland, savanna",
            "palette": ["#8d8d8d", "#7c9a62", "#c9a44a", "#5b4632"],
            "time_of_day": "harsh noon for the walls, warm dusk for trade scenes"
        },
        "objects": [
            {"kind": "props", "name": "conical_tower", "notes": "dry-stone granite wall tower, 10m high, no mortar"},
            {"kind": "hut", "name": "daga_hut", "notes": "daga (clay) hut with thatched cone roof inside stone enclosure"},
            {"kind": "props", "name": "soapstone_bird", "notes": "the Zimbabwe Bird soapstone carving on a plinth"},
            {"kind": "human", "name": "shona_elder", "notes": "elder with iron bangles, cotton wrap, herding stick"},
            {"kind": "animal", "name": "cattle", "notes": "Nguni-patterned cattle herd — wealth and ritual"},
        ],
        "human_details": {"skin_tone": [0.32, 0.18, 0.10]},
        "scenes_template": [
            {"name": "walls", "desc": "Reveal of the great stone enclosure among granite hills", "mood": "majestic"},
            {"name": "trade", "desc": "Gold trade caravan arrives: Chinese celadon, Persian beads", "mood": "bustling"},
            {"name": "cattle", "desc": "Royal cattle parade at dusk", "mood": "golden"}
        ]
    },
    "generic": {
        "aliases": [],
        "era": "ask the AI or edit knowledge.py",
        "place": "unspecified",
        "environment": {
            "terrain": "open grassland, scattered trees, clear sky",
            "palette": ["#7a9a5b", "#c9a44a", "#6b8ba4"],
            "time_of_day": "golden hour"
        },
        "objects": [
            {"kind": "terrain", "name": "landscape", "notes": "background environment"},
            {"kind": "human", "name": "figure_a", "notes": "primary human figure"},
            {"kind": "props", "name": "artifact", "notes": "period artifact"},
        ],
        "human_details": {"skin_tone": [0.35, 0.2, 0.12]},
        "scenes_template": [
            {"name": "establish", "desc": "Wide establishing shot of the environment", "mood": "open"},
            {"name": "focus", "desc": "Close study of the artifact and the people", "mood": "intimate"},
            {"name": "close", "desc": "Reflection and legacy shot", "mood": "warm"}
        ]
    }
}


def match_dossier(topic):
    t = topic.lower()
    best, score = "generic", 0
    for key, d in DOSSIERS.items():
        for alias in d.get("aliases", []):
            if alias in t:
                s = len(alias)
                if s > score:
                    best, score = key, s
    return DOSSIERS[best]
