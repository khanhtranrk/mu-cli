# Shared MU documentation

This directory is reserved for cross-repository architecture, integration contracts and decisions that concern both MU components. Keep implementation-specific documentation in the owning repository.

## Canonical references

- [Coordinated multi-storage cutover](storage-migration.md)

- [MU CLI specification and execution](https://github.com/khanhtranrk/mu-cli/blob/master/docs/spec-format/README.md)
- [MU CLI README](https://github.com/khanhtranrk/mu-cli/blob/master/README.md)
- [MasterFlow architecture and data model](https://github.com/khanhtranrk/mu-masterflow/blob/main/docs/architecture.md)
- [MasterFlow YAML spec editor](https://github.com/khanhtranrk/mu-masterflow/blob/main/docs/spec-yaml.md)
- [MasterFlow worker HTTP hooks](https://github.com/khanhtranrk/mu-masterflow/blob/main/docs/worker-hooks.md)
- [MasterFlow request artifacts](https://github.com/khanhtranrk/mu-masterflow/blob/main/docs/request-artifacts.md)
- [MasterFlow development](https://github.com/khanhtranrk/mu-masterflow/blob/main/docs/development.md)

When changing shared YAML semantics or worker HTTP contracts, check both repositories for compatibility and update the relevant canonical docs rather than copying them here.

- [Creation Spaces upgrade tracker](creation-spaces-upgrade.md): confirmed decisions, implementation phases and verification status.
