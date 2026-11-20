# Changelog

All notable user-facing changes to Mirror are recorded here. Release versions
follow the root workspace version and are published from matching `vX.Y.Z`
Git tags.

## Unreleased

### Added
- Tag-validated GitHub Releases with multi-platform GHCR images published by
  immutable digest, SBOM, and build-provenance attestations.
- Release metadata containing the source commit, Node/npm versions,
  dependency-lock hash, pinned Node base-image digest, OpenAPI hashes, and
  immutable container reference.
- Runtime diagnostics now report the image's injected `MIRROR_VERSION`
  alongside the existing source revision.
- Compose can run either a local source build or an explicitly selected
  published image digest.

### Changed
- Pin the multi-platform Node 24 base image by its official image-index digest.
- Run the same embedded version/revision assertions in GitHub Actions and
  CircleCI container checks.
