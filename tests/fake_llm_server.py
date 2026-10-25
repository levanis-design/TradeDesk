"""A fake OpenAI-compatible chat server for exercising the engine without a real model.

It never calls tools on its own (so no market data is fetched). It returns a tool
call only when the client forces one, which is how TradingAgents asks for structured
output, or when the request carries exactly one tool (a schema bound without forcing, as local servers get it). Everything else is
plain text. It proves the plumbing, not the quality of any model.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HITS = []


def gen(schema, defs, name=""):
    if "$ref" in schema:
        return gen(defs[schema["$ref"].split("/")[-1]], defs, name)
    if "enum" in schema:
        e = schema["enum"]
        return "Overweight" if "Overweight" in e else e[0]
    if "anyOf" in schema:
        non_null = [s for s in schema["anyOf"] if s.get("type") != "null"]
        return gen(non_null[0], defs, name) if non_null else None
    if "allOf" in schema:
        return gen(schema["allOf"][0], defs, name)
    t = schema.get("type")
    if t == "object" or "properties" in schema:
        return {k: gen(v, defs, k) for k, v in schema.get("properties", {}).items()}
    if t == "array":
        return [gen(schema.get("items", {"type": "string"}), defs, name)]
    if t == "number" or t == "integer":
        return 100.0 if t == "number" else 1
    if t == "boolean":
        return True
    if "rating" in name:
        return "Overweight"
    return f"fake {name or 'text'}"


def brief_reply(body):
    """Answer a TRADEDESK_BRIEF prompt with real quotes plus one invented quote, to prove the filter."""
    import re
    text = " ".join(str(m.get("content") or "") for m in body.get("messages", []) if m.get("role") == "user")
    blocks = re.findall(r"=== ([A-Z]+) ===\n(.*?)(?=\n\n=== |\n\nWrite the briefing)", text, flags=re.S)
    if not blocks:
        return None
    src, first = blocks[0]
    words = first.split()
    real = " ".join(words[:14])
    item = lambda r, q, s=src.lower(): {"reason": r, "source": s, "quote": q}
    out = {
        "for": [item("The report supports the rating directly.", real),
                item("A second supporting point from the same report.", " ".join(words[1:15])),
                item("This one is made up and must be dropped.", "the company will certainly triple its revenue by next quarter")],
        "against": [item("There is a stated risk worth weighing.", " ".join(words[2:16]))],
        "would_change": [item("A change in this reading would alter the call.", " ".join(words[:12]))],
    }
    return json.dumps(out)


def respond(body):
    br = brief_reply(body) if "TRADEDESK_BRIEF" in json.dumps(body.get("messages", [])) else None
    if br:
        return {"role": "assistant", "content": br}, "stop"
    tools = body.get("tools") or []
    choice = body.get("tool_choice")
    forced = isinstance(choice, dict) or choice == "required"
    names = [t["function"]["name"] for t in tools]
    HITS.append({"tools": names, "forced": forced, "n_messages": len(body.get("messages", []))})
    pick = None
    if tools and forced:
        want = choice["function"]["name"] if isinstance(choice, dict) else names[0]
        pick = next(t for t in tools if t["function"]["name"] == want)
    elif len(tools) == 1:
        # Local servers get the output schema as one unforced tool.
        pick = tools[0]
    if pick:
        params = pick["function"].get("parameters", {})
        args = gen(params, params.get("$defs", {}))
        return {"role": "assistant", "content": None, "tool_calls": [{
            "id": "call_1", "type": "function",
            "function": {"name": pick["function"]["name"], "arguments": json.dumps(args)}}]}, "tool_calls"
    rf = body.get("response_format") or {}
    if rf.get("type") == "json_schema":
        sch = rf["json_schema"]["schema"]
        return {"role": "assistant", "content": json.dumps(gen(sch, sch.get("$defs", {})))}, "stop"
    return {"role": "assistant", "content": "Fake analysis. Rating: Overweight. This text comes from the test server."}, "stop"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path == "/api/tags":
            data = json.dumps({"models": [
                {"name": "fake:1b", "size": int(1.2 * 1024 ** 3), "details": {"parameter_size": "1B", "quantization_level": "Q4_K_M"}},
                {"name": "huge:70b", "size": int(42 * 1024 ** 3), "details": {"parameter_size": "70B", "quantization_level": "Q4_K_M"}}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/api/version":
            data = json.dumps({"version": "0.0.test"}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)
        elif self.path.endswith("/models"):
            data = json.dumps({"object": "list", "data": [{"id": "fake:1b", "object": "model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(data)
        elif self.path == "/__hits":
            data = json.dumps(HITS).encode()
            self.send_response(200)
            self.end_headers()
            self.wfile.write(data)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        time.sleep(int(os.environ.get("FAKE_DELAY_MS", "0")) / 1000)
        n = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(n) or b"{}")
        msg, reason = respond(body)
        out = {"id": "chatcmpl-fake", "object": "chat.completion", "created": 0,
               "model": body.get("model", "fake"),
               "choices": [{"index": 0, "message": msg, "finish_reason": reason}],
               "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}}
        data = json.dumps(out).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 11999
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
