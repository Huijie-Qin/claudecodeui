import ast
import asyncio
import json
import os
import sys
import traceback


BLOCKED_NAMES = {
    "__import__", "breakpoint", "compile", "delattr", "eval", "exec", "getattr",
    "globals", "help", "input", "locals", "open", "setattr", "vars",
}


def configured_import_allowlist():
    raw = os.environ.get("CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST", "")
    values = set()
    for comma_group in raw.replace(";", ",").split(","):
        for item in comma_group.split():
            name = item.strip()
            if name and name.isidentifier():
                values.add(name)
    return frozenset(values)


ALLOWED_IMPORTS = configured_import_allowlist()
ORIGINAL_IMPORT = __import__


def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    if level != 0 or name not in ALLOWED_IMPORTS:
        raise ImportError(
            f"Python Hook module {name or '(relative)'} is not allowed by "
            "CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST"
        )
    return ORIGINAL_IMPORT(name, globals, locals, fromlist, level)


SAFE_BUILTINS = {
    "__import__": safe_import,
    "abs": abs,
    "all": all,
    "any": any,
    "bool": bool,
    "dict": dict,
    "enumerate": enumerate,
    "filter": filter,
    "float": float,
    "int": int,
    "isinstance": isinstance,
    "len": len,
    "list": list,
    "map": map,
    "max": max,
    "min": min,
    "next": next,
    "range": range,
    "repr": repr,
    "reversed": reversed,
    "round": round,
    "set": set,
    "sorted": sorted,
    "str": str,
    "sum": sum,
    "tuple": tuple,
    "zip": zip,
    "Exception": Exception,
    "ValueError": ValueError,
    "TypeError": TypeError,
}


class ScriptValidator(ast.NodeVisitor):
    def visit_Import(self, node):
        for alias in node.names:
            if alias.name not in ALLOWED_IMPORTS:
                raise ValueError(
                    f"Python Hook module {alias.name} is not allowed by "
                    "CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST"
                )
            if alias.asname and (alias.asname.startswith("__") or alias.asname in BLOCKED_NAMES):
                raise ValueError(f"Python Hook scripts cannot bind import as {alias.asname}")

    def visit_ImportFrom(self, node):
        module = node.module or ""
        if node.level != 0 or module not in ALLOWED_IMPORTS:
            raise ValueError(
                f"Python Hook module {module or '(relative)'} is not allowed by "
                "CCUI_HOOK_PYTHON_IMPORT_ALLOWLIST"
            )
        for alias in node.names:
            if alias.name == "*" or alias.name.startswith("__"):
                raise ValueError("Python Hook scripts cannot use wildcard or dunder imports")
            bound_name = alias.asname or alias.name
            if bound_name.startswith("__") or bound_name in BLOCKED_NAMES:
                raise ValueError(f"Python Hook scripts cannot bind import as {bound_name}")

    def visit_Global(self, node):
        raise ValueError("Python Hook scripts cannot use global declarations")

    def visit_Nonlocal(self, node):
        raise ValueError("Python Hook scripts cannot use nonlocal declarations")

    def visit_Name(self, node):
        if node.id.startswith("__") or node.id in BLOCKED_NAMES:
            raise ValueError(f"Python Hook scripts cannot access {node.id}")
        self.generic_visit(node)

    def visit_Attribute(self, node):
        if node.attr.startswith("__"):
            raise ValueError("Python Hook scripts cannot access dunder attributes")
        self.generic_visit(node)


class Namespace:
    def __init__(self, values):
        object.__setattr__(self, "_values", values)

    def __getattr__(self, name):
        values = object.__getattribute__(self, "_values")
        if name not in values:
            raise AttributeError(name)
        return values[name]

    def __setattr__(self, name, value):
        raise AttributeError("CCUI values are read-only")


class RpcClient:
    def __init__(self):
        self.next_id = 1

    async def call(self, method, args):
        request_id = self.next_id
        self.next_id += 1
        print(json.dumps({"type": "rpc", "id": request_id, "method": method, "args": args}), flush=True)
        line = sys.stdin.readline()
        if not line:
            raise RuntimeError("Hook runtime closed the Python API channel")
        response = json.loads(line)
        if response.get("id") != request_id:
            raise RuntimeError("Hook runtime returned an invalid Python API response")
        if response.get("error"):
            raise RuntimeError(response["error"])
        return response.get("value")


def create_ccui(env):
    rpc = RpcClient()

    class Workspace:
        async def read_text(self, path):
            return await rpc.call("workspace.readText", [path])

        async def write_text(self, path, content):
            return await rpc.call("workspace.writeText", [path, content])

        async def read_json(self, path):
            return await rpc.call("workspace.readJson", [path])

        async def write_json(self, path, value):
            return await rpc.call("workspace.writeJson", [path, value])

        async def list(self, path="."):
            return await rpc.call("workspace.list", [path])

        async def exists(self, path):
            return await rpc.call("workspace.exists", [path])

    class Records:
        async def write(self, record_type, data):
            return await rpc.call("records.write", [record_type, data])

    class Log:
        async def info(self, message, data=None):
            return await rpc.call("log.info", [message, data])

    return Namespace({
        "env": Namespace(dict(env or {})),
        "workspace": Workspace(),
        "records": Records(),
        "log": Log(),
    })


async def main(payload):
    code = str(payload.get("code") or "")
    tree = ast.parse(code, filename=f"hook-{payload.get('hookId') or 'script'}.py", mode="exec")
    ScriptValidator().visit(tree)
    scope = {"__builtins__": SAFE_BUILTINS}
    exec(compile(tree, filename=f"hook-{payload.get('hookId') or 'script'}.py", mode="exec"), scope, scope)
    run = scope.get("run")
    if not callable(run):
        raise ValueError("Script must define async def run(event, ccui)")
    result = run(payload.get("event") or {}, create_ccui(payload.get("env") or {}))
    if not hasattr(result, "__await__"):
        raise ValueError("Python Hook run(event, ccui) must be async")
    return await result


try:
    initial_line = sys.stdin.readline()
    if not initial_line:
        raise RuntimeError("Missing Hook script payload")
    output = asyncio.run(main(json.loads(initial_line)))
    print(json.dumps({"type": "result", "value": output}, ensure_ascii=False), flush=True)
except Exception as error:
    print(json.dumps({
        "type": "error",
        "error": "".join(traceback.format_exception_only(type(error), error)).strip(),
    }, ensure_ascii=False), flush=True)
