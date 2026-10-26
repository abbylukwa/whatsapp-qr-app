"""Task state — atomic progress.json with per-stage / per-object / per-scene
status so ANY interrupted run resumes exactly where it stopped."""
import json
import os
import tempfile


class TaskState:
    STAGES = ("syllabus", "film_plan", "objects", "narration", "assemble", "render_plan")

    def __init__(self, workdir):
        self.workdir = os.path.abspath(workdir)
        self.path = os.path.join(self.workdir, "progress.json")
        os.makedirs(self.workdir, exist_ok=True)
        os.makedirs(os.path.join(self.workdir, "bpy"), exist_ok=True)
        os.makedirs(os.path.join(self.workdir, "audio"), exist_ok=True)
        os.makedirs(os.path.join(self.workdir, "frames"), exist_ok=True)
        self.data = self._load()

    def _load(self):
        if os.path.exists(self.path):
            try:
                with open(self.path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception:
                # corrupt progress -> quarantine and restart the ledger
                try:
                    os.rename(self.path, self.path + f".corrupt-{os.getpid()}")
                except OSError:
                    pass
        return {
            "topic": None, "grade": None, "syllabus": None,
            "stages": {s: "pending" for s in self.STAGES},
            "objects": {},       # name -> {spec, status, bpy, glb}
            "scenes": [],        # [{name, desc, duration, shot, narration}]
            "narration": [],     # [{scene, text, est_seconds, audio}]
            "budget": {"api_calls": 0, "tokens_est": 0},
            "updated_at": None,
        }

    # ── atomic write (tmp + os.replace) ──
    def save(self):
        import datetime
        self.data["updated_at"] = datetime.datetime.utcnow().isoformat() + "Z"
        fd, tmp = tempfile.mkstemp(dir=self.workdir, suffix=".tmp")
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, self.path)

    def stage(self, name, status=None):
        if status is not None:
            self.data["stages"][name] = status
            self.save()
        return self.data["stages"].get(name)

    def obj(self, name, **kw):
        rec = self.data["objects"].setdefault(name, {"status": "pending", "spec": None, "bpy": None})
        for k, v in kw.items():
            rec[k] = v
        self.save()
        return rec

    def api_call(self, tokens_est=800):
        self.data["budget"]["api_calls"] += 1
        self.data["budget"]["tokens_est"] += tokens_est
        self.save()

    def over_budget(self):
        return self.data["budget"]["api_calls"] >= int(os.environ.get("BLENDER_MAX_API_CALLS", "120"))

    def summary(self):
        d = self.data
        objs = d["objects"]
        return {
            "topic": d.get("topic"),
            "grade": d.get("grade"),
            "stages": d["stages"],
            "objects": {k: v.get("status") for k, v in objs.items()},
            "scenes": len(d.get("scenes", [])),
            "api_calls_used": d["budget"]["api_calls"],
        }
