"""Provider-agnostic LLM client (OpenAI-compatible /chat/completions).

Works with: OpenAI, OpenRouter, Groq, Z.ai GLM, Rewind — anything that
speaks the OpenAI wire format. Enforces the API-call budget and, when
no key exists or the budget is spent, cleanly signals the caller to
use the local rules brain instead.
"""
import json
import re
import urllib.request

from . import config


class LLMClient:
    def __init__(self, state=None):
        self.state = state
        self.key = config.API_KEY
        self.url = config.API_URL
        self.model = config.API_MODEL
        self.available = bool(self.key and self.url)

    def _post(self, messages, temperature=0.4, max_tokens=1800, timeout=90):
        body = json.dumps({
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
        }).encode("utf-8")
        req = urllib.request.Request(
            self.url.rstrip("/") + "/chat/completions",
            data=body,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self.key}",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
        return data["choices"][0]["message"]["content"]

    def available_for_call(self):
        return self.available and not (self.state and self.state.over_budget())

    def chat_json(self, system, user, temperature=0.4):
        """Returns parsed JSON (dict/list) or None. Counts against budget."""
        if not self.available_for_call():
            return None
        try:
            raw = self._post(
                [{"role": "system", "content": system},
                 {"role": "user", "content": user}],
                temperature=temperature,
            )
        except Exception as e:
            _log(f"AI call failed ({e}) — falling back to local brain")
            return None
        if self.state:
            self.state.api_call(tokens_est=int(len(system + user) / 4) + 900)
        return extract_json(raw)


def extract_json(text):
    """Robust JSON extraction: survives markdown fences and prose."""
    if not text:
        return None
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.S)
    if m:
        text = m.group(1)
    text = text.strip()
    # direct parse
    try:
        return json.loads(text)
    except Exception:
        pass
    # brace-depth scan for the outermost object or array
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        if start == -1:
            continue
        depth = 0
        for i in range(start, len(text)):
            c = text[i]
            if c == opener:
                depth += 1
            elif c == closer:
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except Exception:
                        break
    return None


def _log(msg):
    print(f"[llm] {msg}")
