# Shared Pipeline parser

The pinned `mu-spec` tarball contains only the shared Pipeline YAML reader and
its fixtures. Its source and packaging live in the MU Convex `packages/spec`
workspace. Replace the tarball with the matching release asset when upgrading,
then update the pin, run `bun install`, and commit the lockfile. The tarball lets
public CI and source builds install without access to the private backend.
