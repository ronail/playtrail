# ADR-0004: Web builds sign registration with a per-release key

**Status:** Accepted. Server side merged in [PR #6](https://github.com/ronail/playtrail/pull/6) and deployed 2026-11-26; a registration signed with the CI key works there ([evidence](../evidence/2026-11-26-live-checks.md)). No web release key is set up. Client signing and build hardening are not built.
**Date:** 2026-11-26

## Context

The Godot web build has no platform attestation, and anything shipped in it can
be extracted. Part of [ADR-0003](0003-registration-requires-app-proof.md).

## Decision

- One Ed25519 pair per release. The Worker holds only public keys (`BUILD_KEYS`).
- The build signs `register\n{build}\n{timestamp}`, accepted within 300 s.
- Planned in the client: signing in a C++ GDExtension, `.pck` encryption with
  custom templates, script obfuscation, stripped symbols.

## Options considered

A shared secret in the build was rejected: public once shipped. For the other
options see ADR-0003.

## Consequences

- One release can be cut off without touching the others.
- This is a **deterrent, not proof**: the key can be extracted and used until the
  build is removed.
- A captured request replays until its timestamp is 300 s old: up to 600 s if
  it was stamped ahead of the server.
- Each release needs a new key added to `BUILD_KEYS`. CI holds its own seed for
  testing the deployment; if it leaks, remove the `ci` entry.
- Unverified: signing from a Godot web export.
