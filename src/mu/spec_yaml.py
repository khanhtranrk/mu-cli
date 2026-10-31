"""Safe YAML loading with literal `on` mapping keys for lifecycle hooks.

Keep existing scalar-value semantics; do not globally change PyYAML resolvers.
"""
from copy import copy

import yaml


class SpecLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        # PyYAML's YAML 1.1 resolver treats `on` as True, even as a mapping key.
        # Copy nodes to avoid modifying aliased scalars or global SafeLoader state.
        node = copy(node)
        pairs = []
        for key, value in node.value:
            if key.value == "on" and key.tag == "tag:yaml.org,2002:bool":
                key = copy(key)
                key.tag = "tag:yaml.org,2002:str"
            pairs.append((key, value))
        node.value = pairs
        return super().construct_mapping(node, deep=deep)


def load_spec_yaml(raw):
    return yaml.load(raw, Loader=SpecLoader)
