"""Minimal stand-in for the slice of Langflow's custom-component API these components use.

Purpose: run and test the REAL component files outside Langflow (no network needed).
It is NOT Langflow. Behaviour that only real Langflow provides (canvas wiring, the Webhook
component, Composio, model components) is not covered. See README, 'What was and was not tested'.
"""
import sys
import types


class _Input:
    def __init__(self, name, display_name=None, info="", value=None, advanced=False, required=False,
                 input_types=None, options=None, **_):
        self.name, self.display_name, self.info, self.value = name, display_name, info, value
        self.advanced, self.required, self.input_types = advanced, required, input_types


class MessageTextInput(_Input): pass
class SecretStrInput(_Input): pass
class BoolInput(_Input): pass
class IntInput(_Input): pass
class DataInput(_Input): pass
class HandleInput(_Input): pass
class DropdownInput(_Input): pass
class MultilineInput(_Input): pass


class Output:
    def __init__(self, display_name, name, method, **_):
        self.display_name, self.name, self.method = display_name, name, method


class Data:
    def __init__(self, data=None, **_):
        self.data = data if data is not None else {}

    def get(self, key, default=None):
        return self.data.get(key, default)


class Message:
    def __init__(self, text="", **_):
        self.text = text
        self.data = {"text": text}


class Component:
    inputs, outputs = [], []

    def __init__(self, **kwargs):
        for i in self.inputs:
            setattr(self, i.name, kwargs.pop(i.name, i.value))
        if kwargs:
            raise TypeError(f"unknown inputs: {sorted(kwargs)}")
        self.status, self._stopped, self._logs = None, set(), []

    def log(self, message, name=None):
        self._logs.append(message)

    def stop(self, output_name):
        self._stopped.add(output_name)


def install():
    mods = {
        "langflow": types.ModuleType("langflow"),
        "langflow.custom": types.ModuleType("langflow.custom"),
        "langflow.io": types.ModuleType("langflow.io"),
        "langflow.schema": types.ModuleType("langflow.schema"),
        "langflow.schema.message": types.ModuleType("langflow.schema.message"),
    }
    mods["langflow.custom"].Component = Component
    for n in ("MessageTextInput", "SecretStrInput", "BoolInput", "IntInput", "DataInput", "HandleInput",
              "DropdownInput", "MultilineInput", "Output"):
        setattr(mods["langflow.io"], n, globals()[n])
    mods["langflow.schema"].Data = Data
    mods["langflow.schema"].message = mods["langflow.schema.message"]
    mods["langflow.schema.message"].Message = Message
    sys.modules.update(mods)


def load_component(path, module_name):
    import importlib.util
    install()
    spec = importlib.util.spec_from_file_location(module_name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
